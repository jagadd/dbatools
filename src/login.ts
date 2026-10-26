import { request } from "node:https";
import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getConfig } from "./powershell.js";
import { helperJson } from "./child-process.js";

async function secretPrompt(): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) throw new Error("Login requires an interactive terminal; do not pass passwords in command arguments");
  stdout.write("Password: ");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let password = "";
    const done = (error?: Error) => {
      stdin.off("data", read); stdin.setRawMode(false); stdin.pause(); stdout.write("\n");
      if (error) reject(error); else resolve(password);
    };
    const read = (data: string) => {
      for (const char of data) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("Login cancelled"));
        if (char === "\u007f" || char === "\b") password = password.slice(0, -1);
        else if (char >= " ") password += char;
      }
    };
    stdin.on("data", read);
  });
}

export async function login(args: string[]) {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--url", "--ca"].includes(args[i]!) || !args[i + 1]) throw new Error("Login accepts only --url and --ca; passwords must be prompted");
    options[args[i]!] = args[i + 1]!;
  }
  if (!options["--url"]) throw new Error("login requires --url https://hostname:8443");
  const url = new URL(options["--url"]);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/", "/mcp"].includes(url.pathname)) throw new Error("Supply an HTTPS origin or /mcp URL without embedded credentials");
  const ca = options["--ca"] ? await readFile(options["--ca"]) : undefined;
  const reader = createInterface({ input: stdin, output: stdout });
  const username = await reader.question("Windows account (SERVER\\username): ");
  reader.close();
  let password = await secretPrompt();
  const body = JSON.stringify({ username, password });
  password = "";
  const response = await new Promise<{ token: string; expiresAt: number }>((resolve, reject) => {
    const req = request(new URL("/auth/login", url), {
      method: "POST", ca, rejectUnauthorized: true,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 20_000,
    }, res => {
      let text = "";
      res.on("data", chunk => {
        text += chunk.toString();
        if (Buffer.byteLength(text) > 16_384) req.destroy(new Error("Login response exceeded its limit"));
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`Login failed (HTTP ${res.statusCode}); check account, group membership, and server availability`));
        try {
          const result = JSON.parse(text);
          if (!/^[A-Za-z0-9_-]{43}$/.test(result.token) || !Number.isFinite(result.expiresAt)) throw new Error();
          resolve(result);
        } catch { reject(new Error("Invalid login response")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Login request timed out")));
    req.end(body);
  });
  const file = join(homedir(), ".dbatools-mcp", "sessions", Buffer.from(url.origin).toString("base64url") + ".json");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  // On Windows, secure the directory before a token is written inside it.
  if (process.platform === "win32") await helperJson(getConfig(), "protect-path.ps1", { path: dirname(file), directory: true });
  await writeFile(file, JSON.stringify({ server: url.origin, ...response }, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
  if (process.platform === "win32") await helperJson(getConfig(), "protect-path.ps1", { path: file, directory: false });
  console.log(`Session saved to ${file}. Expires ${new Date(response.expiresAt).toISOString()}. Configure your MCP client's Authorization header using this protected token; the password was not saved.`);
}
