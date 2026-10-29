import type { DbatoolsCommandHelp } from "./types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

const READONLY_VERBS = new Set([
  "Get", "Test", "Find", "Measure", "Select", "Show",
  "Watch", "Compare", "Search", "Resolve", "Read", "ConvertTo", "Export", "Format", "Where",
]);

const DESTRUCTIVE_VERBS = new Set([
  "Remove", "Drop", "Delete", "Uninstall", "Revoke", "Disable", "Reset",
  "Clear", "Unregister", "Restore", "Stop", "Invoke", "Rename", "Restart", "Write",
]);

/** Parameter names and output columns are validated before becoming script syntax. */
export const PROPERTY_NAME_REGEX = /^[A-Za-z][A-Za-z0-9]*$/;
export const OUTPUT_PROPERTY_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Classify a dbatools command into a risk tier based on its verb.
 * readonly  — safe to run without confirmation
 * change    — modifies state but is reversible
 * destructive — data loss risk; blocked by safe mode until confirm:true
 */
export function classifyCommand(
  name: string
): "readonly" | "change" | "destructive" {
  const verb = name.split("-")[0] ?? "";
  if (READONLY_VERBS.has(verb)) return "readonly";
  if (DESTRUCTIVE_VERBS.has(verb)) return "destructive";
  return "change";
}

/**
 * Map a risk tier (or the generic dispatcher's worst-case tier) onto MCP
 * `ToolAnnotations` hints. `openWorldHint` is true by default because every
 * dbatools call reaches out to an external SQL Server instance; pass
 * `openWorld: false` for tools that never touch a live instance (e.g. the
 * static help/listing tools, which only read the local help index).
 */
export function annotationsForRisk(
  tier: "readonly" | "change" | "destructive",
  opts: { title: string; openWorld?: boolean }
): ToolAnnotations {
  const openWorldHint = opts.openWorld ?? true;
  switch (tier) {
    case "readonly":
      return {
        title: opts.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint,
      };
    case "change":
      return {
        title: opts.title,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint,
      };
    case "destructive":
      return {
        title: opts.title,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint,
      };
  }
}

/**
 * Credential descriptor accepted in the `parameters` map under the key `SqlCredential`.
 * Pass as: { "SqlCredential": { "username": "sa", "password": "secret" } }
 */
export interface SqlCredentialDescriptor {
  username: string;
  password: string;
}

function isSqlCredentialDescriptor(v: unknown): v is SqlCredentialDescriptor {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["username"] === "string" &&
    typeof (v as Record<string, unknown>)["password"] === "string"
  );
}

/**
 * Build a self-contained PowerShell script that imports dbatools, invokes the
 * requested command with the supplied parameters, and emits JSON via
 * ConvertTo-Json so the MCP server gets structured output.
 *
 * Parameter values are supplied separately through the fixed driver on stdin.
 * The driver preserves typed values, including false switch values.
 *
 * Special parameter: SqlCredential — accepts { username, password } and is
 * converted by the driver into a PSCredential without credential script literals.
 */
export function buildPowerShellScript(
  commandName: string,
  args: Record<string, unknown>,
  maxRows: number,
  selectProperties?: string[],
  opts?: { skipImport?: boolean }
): string {
  // Validate command name against an allowlist pattern (letters, digits, hyphens only)
  if (!/^[A-Za-z]+-[A-Za-z][A-Za-z0-9]*$/.test(commandName)) {
    throw new Error(`Invalid command name: ${commandName}`);
  }

  // SQL column names may contain underscores; script syntax remains forbidden.
  if (selectProperties) {
    for (const prop of selectProperties) {
      if (!OUTPUT_PROPERTY_NAME_REGEX.test(prop)) {
        throw new Error(`Invalid property name: ${prop}`);
      }
    }
  }

  // Values travel in the driver's stdin envelope, never inside script literals.
  for (const [key, value] of Object.entries(args)) {
    if (!PROPERTY_NAME_REGEX.test(key)) throw new Error(`Invalid parameter name: ${key}`);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Non-finite number for -${key}`);
  }
  return [
    "Set-StrictMode -Off",
    "$ErrorActionPreference = 'Stop'",
    ...(opts?.skipImport ? [] : ["Import-Module dbatools -ErrorAction Stop"]),
    "$params = $request.parameters",
    ...(selectProperties?.length
      ? [`$result = ${commandName} @params | Select-Object -First ${maxRows} -Property ${selectProperties.join(', ')}`]
      : [`$result = ${commandName} @params | Select-Object -First ${maxRows}`]),
    "ConvertTo-McpJson -InputObject $result",
  ].join("\n");
}

/**
 * Format a DbatoolsCommandHelp record into a concise MCP tool description
 * (≤ 1024 chars, which is the MCP spec recommendation).
 */
export function buildToolDescription(cmd: DbatoolsCommandHelp): string {
  const base = cmd.synopsis || cmd.description || cmd.name;
  const risk =
    cmd.riskLevel === "readonly"
      ? ""
      : ` [${cmd.riskLevel.toUpperCase()} — requires confirm:true]`;
  const full = `${base}${risk}`;
  return full.length > 1024 ? full.substring(0, 1021) + "..." : full;
}
