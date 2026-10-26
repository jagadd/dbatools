import { createHash, randomBytes } from "node:crypto";
import type { Principal, ServerConfig } from "./types.js";
import { helperJson } from "./child-process.js";

export class AccessError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

type Session = { principal: Principal; expiresAt: number };
export class SessionStore {
  private sessions = new Map<string, Session>();
  constructor(private readonly now: () => number = Date.now, private readonly ttl = 3_600_000) {}
  private hash(token: string) { return createHash("sha256").update(token).digest("hex"); }
  issue(principal: Principal): { token: string; expiresAt: number } {
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 1024) throw new AccessError(503, "Session limit reached");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttl;
    this.sessions.set(this.hash(token), { principal, expiresAt });
    return { token, expiresAt };
  }
  authenticate(header: string | undefined): Principal {
    const token = this.token(header);
    const key = this.hash(token);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      throw new AccessError(401, "Invalid or expired session; run the login helper again");
    }
    return session.principal;
  }
  revoke(header: string | undefined) { this.authenticate(header); this.sessions.delete(this.hash(this.token(header))); }
  clear() { this.sessions.clear(); }
  private token(header: string | undefined): string {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!match) throw new AccessError(401, "Bearer session token required");
    return match[1]!;
  }
}

export type WindowsValidator = (username: string, password: string) => Promise<Principal>;
export function windowsValidator(config: ServerConfig): WindowsValidator {
  return async (username, password) => {
    if (process.platform !== "win32") throw new AccessError(503, "Windows-account login requires a Windows MCP host");
    const result = await helperJson<{ ok: boolean; sid?: string; roles?: string[]; status?: number }>(
      config, "authenticate-windows.ps1", { username, password },
    );
    if (!result.ok) throw new AccessError(result.status === 403 ? 403 : 401, "Windows login failed or account is not authorized");
    if (!result.sid || !result.roles?.length || result.roles.some(role => role !== "reader" && role !== "operator")) {
      throw new AccessError(503, "Invalid Windows authentication response");
    }
    return { kind: "windows", sid: result.sid, roles: result.roles as Principal["roles"] };
  };
}

/** Fixed window limits are bounded and contain no login names or passwords. */
export class LoginLimiter {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  take(address: string): void {
    const now = this.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const entry = this.attempts.get(address);
    if (entry && entry.count >= 5) throw new AccessError(429, "Too many login attempts; retry in 15 minutes");
    if (!entry && this.attempts.size >= 4096) throw new AccessError(429, "Login rate limit reached");
    this.attempts.set(address, { count: (entry?.count ?? 0) + 1, until: entry?.until ?? now + 900_000 });
  }
}
