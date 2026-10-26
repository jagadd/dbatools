import { spawnHelper } from "./child-process.js";
import type { ExecutionData, PowerShellResult, ServerConfig } from "./types.js";

/** Maximum framed stdout+stderr bytes; the driver limits decoded output to 10 MB. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Parse an integer env var, falling back to `defaultVal` when the value is
 * missing, non-numeric, or outside the given bounds.
 */
function parseIntEnv(
  key: string,
  defaultVal: number,
  min: number,
  max: number
): number {
  const raw = process.env[key];
  if (!raw) return defaultVal;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return defaultVal;
  return parsed;
}

/**
 * Resolve runtime configuration from environment variables with safe defaults.
 * All values can be overridden without code changes.
 */
export function getConfig(): ServerConfig {
  const transport = process.env["DBATOOLS_TRANSPORT"] ?? "stdio";
  if (transport !== "stdio" && transport !== "https") throw new Error("DBATOOLS_TRANSPORT must be stdio or https");
  return {
    transport,
    powershellExe: process.env["PWSH_EXE"] ?? "pwsh",
    safeMode: process.env["DBATOOLS_SAFE_MODE"] !== "false",
    maxOutputRows: parseIntEnv("MAX_OUTPUT_ROWS", 100, 1, 10_000),
    commandTimeout: parseIntEnv("COMMAND_TIMEOUT_SECONDS", 60, 5, 3600),
    usePersistentSession: process.env["DBATOOLS_PERSISTENT_SESSION"] !== "false",
  };
}

/**
 * Spawn a PowerShell process, run the given script, and collect stdout/stderr.
 * Rejects only on process spawn failure; non-zero exit codes are resolved normally
 * so the caller can inspect exitCode and stderr.
 */
export function runPowerShell(
  script: string,
  config: ServerConfig,
  data: ExecutionData = {}
): Promise<PowerShellResult> {
  return new Promise((resolve, reject) => {
    // The executable arguments contain only a fixed driver path. All request
    // data, including legacy inline credentials, is delivered on stdin.
    const pwsh = spawnHelper(config, "run-command.ps1");

    let stdout = "";
    let totalBytes = 0;
    let settled = false;

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      pwsh.kill("SIGKILL");
      reject(err);
    }

    const timer = setTimeout(() => {
      fail(new Error(`PowerShell process timed out after ${config.commandTimeout}s`));
    }, config.commandTimeout * 1000);

    pwsh.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BUFFER_BYTES) {
        clearTimeout(timer);
        fail(new Error(`PowerShell output exceeded the ${MAX_BUFFER_BYTES / 1024 / 1024} MB safety limit`));
        return;
      }
      stdout += chunk.toString();
    });

    pwsh.stderr.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BUFFER_BYTES) {
        clearTimeout(timer);
        fail(new Error(`PowerShell output exceeded the ${MAX_BUFFER_BYTES / 1024 / 1024} MB safety limit`));
        return;
      }
      // Driver errors can contain sensitive data; do not return raw host stderr.
    });

    pwsh.stdin.on("error", () => { clearTimeout(timer); fail(new Error("PowerShell driver input failed")); });
    pwsh.stdin.end(JSON.stringify({ ...data, id: "one-shot", script, parameters: data.parameters ?? {}, credentialFiles: data.credentialFiles ?? {} }) + "\n");

    pwsh.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) return resolve({ stdout: "", stderr: "PowerShell driver exited unexpectedly", exitCode: code ?? 1 });
      try {
        const lines = stdout.trim().split(/\r?\n/);
        const result = JSON.parse(Buffer.from(lines.at(-1) ?? "", "base64").toString("utf8"));
        if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || !Number.isInteger(result.exitCode)) throw new Error();
        resolve({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
      } catch { reject(new Error("Invalid PowerShell driver response")); }
    });

    pwsh.on("error", (err) => {
      clearTimeout(timer);
      fail(new Error(`Failed to launch '${config.powershellExe}': ${err.message}`));
    });
  });
}

/**
 * Quick health-check: verifies that PowerShell and the dbatools module are
 * available on the current machine.
 */
export async function checkDbatools(
  config: ServerConfig
): Promise<{ ok: boolean; version?: string; identity?: string; error?: string }> {
  try {
    const result = await runPowerShell(
      `$m = Get-Module -ListAvailable -Name dbatools | ` +
        `Sort-Object Version -Descending | Select-Object -First 1; ` +
        `if ($m) { @{ version = $m.Version.ToString(); identity = [Environment]::UserName } | ConvertTo-Json -Compress } else { throw "dbatools module not found" }`,
      config
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { ok: true, ...JSON.parse(result.stdout.trim()) };
    }
    return {
      ok: false,
      error:
        "dbatools module not found. Install it with: Install-Module dbatools -Scope CurrentUser",
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export interface VersionMismatchResult {
  installedVersion: string;
  indexedVersion: string;
  isStale: boolean;
  message: string;
}

/**
 * Compare the installed dbatools version against the version stored in the
 * help-index manifest. Returns a structured result with a human-readable
 * warning when the two differ.
 */
export async function checkVersionMismatch(
  config: ServerConfig,
  indexedVersion: string,
  check: typeof checkDbatools = checkDbatools
): Promise<VersionMismatchResult> {
  const checked = await check(config);

  if (!checked.ok || !checked.version) {
    return {
      installedVersion: "unknown",
      indexedVersion,
      isStale: false,
      message: checked.error ?? "Could not determine installed dbatools version.",
    };
  }

  const installed = checked.version.trim();
  const isStale = installed !== indexedVersion;

  const message = isStale
    ? `⚠️  dbatools version mismatch detected!\n` +
      `   Installed : ${installed}\n` +
      `   Index     : ${indexedVersion}\n` +
      `   The help index is stale. Run 'npm run refresh-help' to rebuild it.\n` +
      `   Until then, command metadata may be inaccurate for new/changed commands.`
    : `✅ dbatools version matches index (${installed}).`;

  return { installedVersion: installed, indexedVersion, isStale, message };
}
