import express, { type ErrorRequestHandler } from "express";
import { createServer as createHttpsServer, type ServerOptions } from "node:https";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AccessError, LoginLimiter, SessionStore, windowsValidator, type WindowsValidator } from "./auth.js";
import { createServer, type ServerDependencies } from "./server-factory.js";
import { runPowerShell } from "./powershell.js";
import type { Executor, ServerConfig } from "./types.js";

export class ExecutionLimiter {
  private active = 0;
  constructor(private readonly limit = 2) {}
  wrap(execute: Executor): Executor {
    return async (...args) => {
      if (this.active >= this.limit) throw new Error("Execution capacity reached; retry later (no command was started)");
      this.active++;
      try { return await execute(...args); } finally { this.active--; }
    };
  }
}

export interface HttpsOptions {
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  tls: ServerOptions;
}

export function getHttpsOptions(): HttpsOptions {
  const cert = process.env.DBATOOLS_TLS_CERT_FILE;
  const key = process.env.DBATOOLS_TLS_KEY_FILE;
  const hosts = (process.env.DBATOOLS_HTTPS_ALLOWED_HOSTS ?? "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!cert || !key) throw new Error("HTTPS requires DBATOOLS_TLS_CERT_FILE and DBATOOLS_TLS_KEY_FILE (PEM files)");
  if (!hosts.length || hosts.some(h => h.includes("*") || /[\s/@]/.test(h))) throw new Error("Configure DBATOOLS_HTTPS_ALLOWED_HOSTS with explicit hostnames (no wildcards or ports)");
  const port = Number(process.env.DBATOOLS_HTTPS_PORT ?? 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid DBATOOLS_HTTPS_PORT");
  try {
    return {
      host: process.env.DBATOOLS_HTTPS_HOST ?? "127.0.0.1", port, allowedHosts: hosts,
      allowedOrigins: (process.env.DBATOOLS_HTTPS_ALLOWED_ORIGINS ?? "").split(",").map(x => x.trim()).filter(Boolean),
      tls: { cert: readFileSync(cert), key: readFileSync(key), minVersion: "TLSv1.2" },
    };
  } catch { throw new Error("Unable to read HTTPS certificate/key; check paths and service-account permissions"); }
}

export function createHttpsService(config: ServerConfig, options: HttpsOptions, overrides: {
  validate?: WindowsValidator; sessions?: SessionStore; dependencies?: Partial<ServerDependencies>;
} = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  const sessions = overrides.sessions ?? new SessionStore();
  const validate = overrides.validate ?? windowsValidator(config);
  const loginLimiter = new LoginLimiter();
  const limiter = new ExecutionLimiter();
  const effectiveConfig = { ...config, transport: "https" as const, usePersistentSession: false };
  const execute = limiter.wrap(overrides.dependencies?.execute ?? runPowerShell);
  // Environment probes also consume process slots; metadata reads do not.
  const checkEnvironment = async () => {
    const result = await execute(
      "$m = Get-Module -ListAvailable dbatools | Sort-Object Version -Descending | Select-Object -First 1; if (-not $m) { throw 'dbatools module not installed' }; @{ version = $m.Version.ToString(); identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name } | ConvertTo-Json -Compress",
      effectiveConfig,
    );
    if (result.exitCode !== 0) return { ok: false, error: result.stderr };
    try { return { ok: true, ...JSON.parse(result.stdout) } as { ok: boolean; version: string; identity: string }; }
    catch { return { ok: false, error: "Invalid environment response" }; }
  };
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!host || !options.allowedHosts.includes(req.hostname.toLowerCase())) return res.status(403).json({ error: "Host is not allowed" });
    const origin = req.headers.origin;
    if (origin && !options.allowedOrigins.includes(origin)) return res.status(403).json({ error: "Origin is not allowed" });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  const loginSchema = z.object({ username: z.string().min(3).max(256), password: z.string().min(1).max(4096) }).strict();
  app.post("/auth/login", express.json({ limit: "16kb" }), async (req, res, next) => {
    try {
      loginLimiter.take(req.socket.remoteAddress ?? "unknown");
      const credentials = loginSchema.parse(req.body);
      const principal = await validate(credentials.username, credentials.password);
      req.body = undefined;
      res.json({ ...sessions.issue(principal), tokenType: "Bearer" });
    } catch (error) { req.body = undefined; next(error); }
  });
  app.post("/auth/logout", (req, res, next) => {
    try { sessions.revoke(req.headers.authorization); res.sendStatus(204); } catch (error) { next(error); }
  });
  app.all("/mcp", (req, res, next) => {
    try { res.locals.principal = sessions.authenticate(req.headers.authorization); next(); }
    catch (error) { next(error); }
  }, express.json({ limit: "1mb" }), async (req, res, next) => {
    const principal = res.locals.principal;
    if (req.body?.method === "tools/call" && req.body?.params?.name === "invoke_dbatools_command" && !principal.roles.includes("operator")) {
      const audit = overrides.dependencies?.audit ?? ((event: Record<string, unknown>) => console.error(JSON.stringify(event)));
      audit({ requestId: randomUUID(), sid: principal.sid, commandName: "invoke_dbatools_command", outcome: "denied", durationMs: 0 });
      return res.status(403).json({ error: "Operator permission is required" });
    }
    const server = createServer({
      ...overrides.dependencies, config: effectiveConfig, principal, execute,
      checkEnvironment: overrides.dependencies?.checkEnvironment ?? checkEnvironment,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (error) { next(error); }
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const status = error instanceof AccessError ? error.status : error instanceof z.ZodError ? 400 : error?.status === 413 ? 413 : error?.type === "entity.parse.failed" ? 400 : 503;
    if (status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="dbatools-mcp"');
    const message = error instanceof AccessError ? error.message : status === 400 ? "Invalid request" : status === 413 ? "Request too large" : "Service unavailable; check Windows service prerequisites";
    res.status(status).json({ error: message });
  };
  app.use(errors);
  const server = createHttpsServer(options.tls, app);
  server.requestTimeout = 3_700_000;
  server.headersTimeout = 15_000;
  server.on("close", () => sessions.clear());
  return { server, sessions };
}
