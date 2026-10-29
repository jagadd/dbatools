import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import type { Executor, Principal, ServerConfig, HelpManifest } from "./types.js";
import { credentialAlias, fileCredentialResolver, validateCredentialInputs, redact, type CredentialResolver } from "./credentials.js";
import { AccessError } from "./auth.js";
import { z } from "zod";

import { loadHelpManifest, searchCommands } from "./help-indexer.js";
import { checkDbatools, checkVersionMismatch, type VersionMismatchResult } from "./powershell.js";
import { persistentSession, runPowerShellPersistent } from "./powershell-session.js";
import {
  annotationsForRisk,
  buildPowerShellScript,
  PROPERTY_NAME_REGEX,
} from "./tool-registry.js";

export interface ServerDependencies {
  config: ServerConfig;
  principal: Principal;
  execute?: Executor;
  resolveCredentials?: CredentialResolver;
  manifest?: () => HelpManifest;
  checkEnvironment?: typeof checkDbatools;
  audit?: (event: Record<string, unknown>) => void;
}

export function createServer(dependencies: ServerDependencies): McpServer {
  const { config, principal } = dependencies;
  const execute = dependencies.execute ?? runPowerShellPersistent;
  const resolveCredentials = dependencies.resolveCredentials ?? fileCredentialResolver(config);
  const readManifest = dependencies.manifest ?? loadHelpManifest;
  const helpIndex = () => readManifest().commands;
  const checkEnvironment = dependencies.checkEnvironment ?? checkDbatools;
  const audit = dependencies.audit ?? ((event) => console.error(JSON.stringify(event)));

  // Version mismatch state — resolved once at startup, reused by tools
  let versionState: VersionMismatchResult | null = null;

  async function getVersionState(): Promise<VersionMismatchResult> {
    if (versionState) return versionState;
    try {
      const manifest = readManifest();
      versionState = await checkVersionMismatch(config, manifest.dbatoolsVersion, checkEnvironment);
    } catch {
      versionState = {
        installedVersion: "unknown",
        indexedVersion: "unknown",
        isStale: false,
        message: "Help index not yet generated — run 'npm run refresh-help'.",
      };
    }
    return versionState;
  }

  const server = new McpServer({
    name: "dbatools-mcp-server",
    version: "0.8.0",
  });

  // ---------------------------------------------------------------------------
  // Tool: list_dbatools_commands
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_dbatools_commands",
    {
      description: "Search and list dbatools commands. Filter by verb, noun, keyword, or risk level.",
      annotations: annotationsForRisk("readonly", {
        title: "List dbatools Commands",
        openWorld: false,
      }),
      inputSchema: {
        verb: z
          .string()
          .max(50)
          .optional()
          .describe("PowerShell verb (e.g. Get, Set, New, Remove, Test)"),
        noun: z
          .string()
          .max(100)
          .optional()
          .describe("Noun fragment to match (e.g. Database, Login, AgentJob)"),
        keyword: z
          .string()
          .max(200)
          .optional()
          .describe("Keyword to search in name, synopsis, and description"),
        riskLevel: z
          .enum(["readonly", "change", "destructive"])
          .optional()
          .describe("Filter by risk tier"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Maximum number of results (default 50, max 200)"),
      },
    },
    async ({ verb, noun, keyword, riskLevel, limit }) => {
      const vs = await getVersionState();
      const stalePrefix = vs.isStale ? vs.message + "\n\n" : "";

      let index;
      try {
        index = helpIndex();
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Help index unavailable: ${String(e)}` }], isError: true };
      }
      const results = searchCommands(index, { verb, noun, keyword, riskLevel, limit });

      if (results.length === 0) {
        return {
          content: [
            { type: "text", text: stalePrefix + "No commands found matching the given filters." },
          ],
        };
      }

      const header = `Found ${results.length} command(s):\n`;
      const rows = results
        .map(
          (c) =>
            `${c.name.padEnd(50)} [${c.riskLevel.padEnd(11)}]  ${(c.synopsis ?? "").substring(0, 80)}`
        )
        .join("\n");

      return { content: [{ type: "text", text: stalePrefix + header + rows }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_dbatools_command_help
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_dbatools_command_help",
    {
      description:
        "Get the full normalized help for a specific dbatools command, including parameters and examples sourced from comment-based help.",
      annotations: annotationsForRisk("readonly", {
        title: "Get dbatools Command Help",
        openWorld: false,
      }),
      inputSchema: {
        commandName: z
          .string()
          .max(100)
          .describe("Exact command name, e.g. Get-DbaDatabase"),
      },
    },
    async ({ commandName }) => {
      const vs = await getVersionState();
      const stalePrefix = vs.isStale ? vs.message + "\n\n" : "";

      let index;
      try {
        index = helpIndex();
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Help index unavailable: ${String(e)}` }], isError: true };
      }
      const help = index[commandName];

      if (!help) {
        return {
          content: [
            {
              type: "text",
              text:
                stalePrefix +
                `Command '${commandName}' not found in the help index.\n` +
                `Use list_dbatools_commands to discover available commands.`,
            },
          ],
          isError: true,
        };
      }

      const paramLines =
        help.parameters.length === 0
          ? "  (none documented)"
          : help.parameters
              .map((p) => {
                const req = p.required ? " [REQUIRED]" : "";
                const aliases =
                  p.aliases.length > 0
                    ? `  aliases: ${p.aliases.join(", ")}`
                    : "";
                const pipeline = p.pipelineInput ? "  pipeline input: yes" : "";
                return (
                  `  -${p.name} <${p.type}>${req}` +
                  `${aliases}${pipeline}\n    ${p.description || "(no description)"}`
                );
              })
              .join("\n\n");

      const exampleLines =
        help.examples.length === 0
          ? "  (none documented)"
          : help.examples
              .slice(0, 5)
              .map(
                (ex, i) =>
                  `--- Example ${i + 1}${ex.title ? ": " + ex.title : ""} ---\n` +
                  `${ex.code}\n` +
                  (ex.remarks ? `Remarks: ${ex.remarks}` : "")
              )
              .join("\n\n");

      const text = [
        `NAME:        ${help.name}`,
        `RISK LEVEL:  ${help.riskLevel}`,
        `VERB / NOUN: ${help.verb} / ${help.noun}`,
        ``,
        `SYNOPSIS`,
        `--------`,
        help.synopsis || "(none)",
        ``,
        `DESCRIPTION`,
        `-----------`,
        help.description || "(none)",
        ``,
        `PARAMETERS`,
        `----------`,
        paramLines,
        ``,
        `EXAMPLES`,
        `--------`,
        exampleLines,
        help.relatedLinks.length > 0
          ? `\nRELATED LINKS\n-------------\n${help.relatedLinks.join("\n")}`
          : "",
      ]
        .join("\n")
        .trim();

      return { content: [{ type: "text", text: stalePrefix + text }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: invoke_dbatools_command
  // ---------------------------------------------------------------------------
  server.registerTool(
    "invoke_dbatools_command",
    {
      description:
        "Execute a dbatools command via PowerShell and return structured JSON output.\n\nSAFETY: For any destructive or change command (Remove, Drop, Disable, Reset, etc.), always explain the consequences to the user and ask for explicit confirmation before running. Only proceed with confirm:true if the user has clearly confirmed their intent. Respect DBATOOLS_SAFE_MODE: never bypass safety checks. For any command that modifies or deletes data, double-check with the user before proceeding. Show the exact command and output for transparency. Non-readonly commands require confirm:true when safe mode is enabled.",
      // This is a generic dispatcher that can run any dbatools command, so the
      // annotation must conservatively reflect the worst case — it cannot be
      // narrowed per-call since MCP tool annotations are static. Individual
      // commands' actual risk level is still enforced at runtime via the safe
      // mode gate below.
      annotations: annotationsForRisk("destructive", { title: "Invoke dbatools Command" }),
      inputSchema: {
        commandName: z
          .string()
          .max(100)
          .describe("Exact dbatools command name to execute, e.g. Get-DbaDatabase"),
        parameters: z
          .record(z.string(), z.unknown())
          .default({})
          .describe(config.transport === "https"
            ? "Non-sensitive command parameters. Use credentialRefs for every credential parameter; do not put passwords in tool arguments."
            : "Command parameters. Legacy SqlCredential objects are supported, but credentialRefs are preferred to keep passwords out of tool arguments."),
        credentialRefs: z.record(z.string().regex(PROPERTY_NAME_REGEX), credentialAlias).default({})
          .describe("Map documented credential parameter names to authorized server-side credential profile aliases; never supply passwords over HTTPS."),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            "Set to true to allow execution of change/destructive commands (required when safeMode is on)"
          ),
        selectProperties: z
          .array(z.string().trim().regex(PROPERTY_NAME_REGEX, 'Property names must be alphanumeric and start with a letter').max(100))
          .min(1, 'selectProperties must contain at least one property name')
          .max(50)
          .optional()
          .describe(
            "List of property names to select from the output (e.g. ['Name', 'Status', 'SizeMB']). " +
            "Use this to reduce output size for commands that return complex objects like SMO database or login objects. " +
            "When omitted, all properties are returned."
          ),
      },
    },
    async ({ commandName, parameters, credentialRefs, confirm, selectProperties }) => {
      const started = Date.now();
      const event = { requestId: randomUUID(), sid: principal.sid, commandName };
      const complete = (outcome: string) => audit({ ...event, outcome, durationMs: Date.now() - started });
      if (principal.kind === "windows" && !principal.roles.includes("operator")) {
        complete("denied");
        return { content: [{ type: "text" as const, text: "Operator permission is required" }], isError: true };
      }
      let index;
      try {
        index = helpIndex();
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Help index unavailable: ${String(e)}` }], isError: true };
      }
      const help = index[commandName];

      if (!help) {
        return {
          content: [
            {
              type: "text",
              text:
                `Unknown command: '${commandName}'.\n` +
                `Use list_dbatools_commands to discover available commands.`,
            },
          ],
          isError: true,
        };
      }

      // Safety gate: block non-readonly commands unless confirmed
      if (config.safeMode && help.riskLevel !== "readonly" && !confirm) {
        complete("confirmation_required");
        return {
          content: [
            {
              type: "text",
              text:
                `Command '${commandName}' has risk level '${help.riskLevel}'.\n` +
                `Set confirm: true to allow execution, or use a readonly command instead.`,
            },
          ],
          isError: true,
        };
      }

      let script: string;
      let credentialFiles: Record<string, string>;
      let credentialParameters: string[];
      try {
        credentialParameters = validateCredentialInputs(help, parameters, credentialRefs, config.transport === "https");
        credentialFiles = await resolveCredentials(credentialRefs, principal);
        script = buildPowerShellScript(
          commandName,
          parameters as Record<string, unknown>,
          config.maxOutputRows,
          selectProperties,
          { skipImport: config.usePersistentSession }
        );
      } catch (e) {
        complete(e instanceof AccessError ? "denied" : "validation_failed");
        return {
          content: [{ type: "text", text: redact(`Parameter validation error: ${String(e)}`, parameters) }],
          isError: true,
        };
      }

      let result;
      try {
        result = await execute(script, config, { parameters, credentialParameters, credentialFiles });
        result = { ...result, stdout: redact(result.stdout, parameters), stderr: redact(result.stderr, parameters) };
      } catch (e) {
        complete("execution_failed");
        return {
          content: [{ type: "text", text: redact(`PowerShell execution failed: ${String(e)}`, parameters) }],
          isError: true,
        };
      }

      if (result.exitCode !== 0) {
        complete("execution_failed");
        return {
          content: [
            {
              type: "text",
              text:
                `Command failed (exit ${result.exitCode}):\n` +
                (result.stderr || result.stdout || "(no output)"),
            },
          ],
          isError: true,
        };
      }

      // Try to parse structured output
      let parsed: unknown = undefined;
      const trimmed = result.stdout.trim();
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Not JSON — return raw text
        }
      }

      const recordCount = Array.isArray(parsed)
        ? parsed.length
        : parsed != null
          ? 1
          : 0;

      complete("succeeded");
      const summary = `Executed '${commandName}' — ${recordCount} record(s) returned.`;

      const body = parsed
        ? JSON.stringify(parsed, null, 2)
        : trimmed || "(no output)";

      const stderrSection =
        result.stderr.trim() ? `\n\nSTDERR:\n${result.stderr.trim()}` : "";

      return {
        content: [
          { type: "text", text: `${summary}\n\n${body}${stderrSection}` },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: check_dbatools_environment
  // ---------------------------------------------------------------------------
  server.registerTool(
    "check_dbatools_environment",
    {
      description: "Verify that PowerShell and the dbatools module are installed and report the help-index status.",
      annotations: annotationsForRisk("readonly", { title: "Check dbatools Environment" }),
      inputSchema: {},
    },
    async () => {
      const check = await checkEnvironment(config);

      if (!check.ok) {
        return {
          content: [
            {
              type: "text",
              text: `dbatools not available: ${check.error}`,
            },
          ],
          isError: true,
        };
      }

      let indexInfo = "Help index: not generated yet (run 'npm run refresh-help')";
      let vsMismatch = "";
      try {
        const manifest = readManifest();
        indexInfo =
          `Help index: ${manifest.commandCount} commands indexed\n` +
          `  dbatools version in index: ${manifest.dbatoolsVersion}\n` +
          `  Generated at:              ${manifest.generatedAt}`;
        const vs = await checkVersionMismatch(config, manifest.dbatoolsVersion, checkEnvironment);
        // Invalidate cached state so next tool call re-evaluates
        versionState = vs;
        vsMismatch = vs.message;
      } catch {
        // Index missing — that's fine, non-fatal
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `dbatools ${check.version} is installed and ready.`,
              `Execution identity: ${check.identity ?? "unavailable"} (MCP host account; no caller impersonation)`,
              indexInfo,
              vsMismatch,
              `Safe mode:       ${config.safeMode ? "ON (non-readonly commands require confirm:true)" : "OFF"}`,
              `Max output rows: ${config.maxOutputRows}`,
              `Timeout:         ${config.commandTimeout}s`,
              `Persistent session: ${
                !config.usePersistentSession
                  ? "disabled (DBATOOLS_PERSISTENT_SESSION=false)"
                  : persistentSession.isActive()
                    ? "active (dbatools pre-imported)"
                    : "enabled, not started yet (starts on first invoke_dbatools_command call)"
              }`,
            ].filter(Boolean).join("\n"),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Resource: dbatools://command/{name}
  // Exposes each command's full normalized help as a browsable/structured MCP
  // resource (as distinct from the list_dbatools_commands / get_dbatools_command_help
  // tools, which return human-readable text aimed at being read in a chat reply).
  // ---------------------------------------------------------------------------
  server.registerResource(
    "dbatools_command",
    new ResourceTemplate("dbatools://command/{name}", {
      list: async () => {
        let index;
        try {
          index = helpIndex();
        } catch {
          return { resources: [] };
        }
        const resources = Object.values(index)
          // Aliases just forward to another command's help, so they'd only add
          // near-duplicate entries to the browsable list; skip them.
          .filter((c) => c.commandType !== "Alias")
          .map((c) => ({
            uri: `dbatools://command/${c.name}`,
            name: c.name,
            title: c.name,
            description: c.synopsis || undefined,
            mimeType: "application/json",
          }));
        return { resources };
      },
    }),
    {
      title: "dbatools Command Reference",
      description:
        "Full normalized help (synopsis, parameters, examples, risk level) for one dbatools command, as JSON.",
      mimeType: "application/json",
    },
    async (uri, { name }) => {
      const commandName = Array.isArray(name) ? name[0] : name;
      let index;
      try {
        index = helpIndex();
      } catch (e) {
        throw new Error(`Help index unavailable: ${String(e)}`);
      }
      const help = index[commandName ?? ""];
      if (!help) {
        throw new Error(
          `Command '${commandName}' not found in the help index. ` +
            `Use list_dbatools_commands or browse dbatools://command/ to discover available commands.`
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(help, null, 2),
          },
        ],
      };
    }
  );

  return server;
}
