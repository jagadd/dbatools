import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./types.js";

export function helperPath(name: string): string {
  return fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
}

/** Deliberately exclude MCP tokens, login passwords, and server secret configuration. */
export function powerShellEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "path", "systemroot", "windir", "temp", "tmp", "home", "userprofile",
    "localappdata", "appdata", "psmodulepath", "computername", "username", "userdomain",
    "programfiles", "programfiles(x86)", "programw6432", "number_of_processors",
    "processor_architecture", "lang", "lc_all", "dotnet_root", "pathext",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase())) env[key] = value;
  }
  env.DBATOOLS_DISABLE_LOGGING = "true";
  env.DBATOOLS_DISABLE_TEPP = "true";
  return env;
}

export function spawnHelper(config: ServerConfig, name: string, args: string[] = []) {
  return spawn(config.powershellExe, ["-NonInteractive", "-NoProfile", "-NoLogo", "-File", helperPath(name), ...args], {
    shell: false, env: powerShellEnvironment(), windowsHide: true,
  });
}

export async function helperJson<T>(config: ServerConfig, name: string, data: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawnHelper(config, name);
    let output = "";
    let size = 0;
    let done = false;
    const finish = (error?: Error, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("Windows helper timed out")), 15_000);
    child.on("error", () => finish(new Error("Unable to start the Windows PowerShell helper")));
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) return finish(new Error("Windows helper output exceeded its limit"));
      output += chunk.toString();
    });
    // Never surface helper stderr: authentication helpers handle sensitive input.
    child.stderr.resume();
    child.on("close", code => {
      if (code !== 0) return finish(new Error("Windows helper failed; check service identity and file permissions"));
      try { finish(undefined, JSON.parse(output)); }
      catch { finish(new Error("Invalid Windows helper response")); }
    });
    child.stdin.on("error", () => finish(new Error("Windows helper input failed")));
    child.stdin.end(JSON.stringify(data) + "\n");
  });
}
