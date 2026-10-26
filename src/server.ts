#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server-factory.js";
import { getConfig } from "./powershell.js";
import { persistentSession } from "./powershell-session.js";
import { createHttpsService, getHttpsOptions } from "./https-server.js";
import { login } from "./login.js";

async function main() {
  if (process.argv[2] === "login") { await login(process.argv.slice(3)); return; }
  if (process.argv.length > 2) throw new Error("Usage: dbatools-mcp-server [login --url https://host:8443 [--ca path]]");
  const config = getConfig();
  if (config.transport === "https") {
    const options = getHttpsOptions();
    const { server } = createHttpsService(config, options);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, resolve);
    });
    console.error(`dbatools MCP HTTPS listening on ${options.host}:${options.port}; PowerShell runs as the service account`);
    const stop = () => {
      server.close();
      const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 15_000);
      timeout.unref();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    const server = createServer({ config, principal: { kind: "local", sid: "local-process", roles: ["reader", "operator"] } });
    await server.connect(new StdioServerTransport());
    process.on("exit", () => persistentSession.shutdown());
    const stop = () => { persistentSession.shutdown(); void server.close().finally(() => process.exit(0)); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdin.on("end", stop);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "MCP startup failed"); process.exitCode = 1; });
