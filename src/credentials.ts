import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { DbatoolsCommandHelp, Principal, ServerConfig } from "./types.js";
import { AccessError } from "./auth.js";
import { helperJson } from "./child-process.js";

export const credentialAlias = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const manifestSchema = z.record(credentialAlias, z.object({
  file: z.string().min(1), allowedSids: z.array(z.string().regex(/^S-1-\d+(?:-\d+)+$/)).default([]),
  allowLocal: z.boolean().default(false),
}).strict());

export type CredentialResolver = (refs: Record<string, string>, principal: Principal) => Promise<Record<string, string>>;

export function credentialNames(help: DbatoolsCommandHelp): string[] {
  return [...new Set(["SqlCredential", ...help.parameters.filter(p => /(?:PSCredential|SecureString)/i.test(p.type)).map(p => p.name)])];
}

export function validateCredentialInputs(help: DbatoolsCommandHelp, parameters: Record<string, unknown>, refs: Record<string, string>, remote: boolean): string[] {
  const names = credentialNames(help);
  const credentialKeys = new Set(names.map(n => n.toLowerCase()));
  // Get-Help aliases must not provide a bypass for HTTPS credential policy.
  for (const parameter of help.parameters) {
    if (credentialKeys.has(parameter.name.toLowerCase())) for (const alias of parameter.aliases) credentialKeys.add(alias.toLowerCase());
  }
  const used = new Set<string>();
  const common = new Set(["verbose", "debug", "erroraction", "warningaction", "informationaction", "progressaction", "errorvariable", "warningvariable", "informationvariable", "outvariable", "outbuffer", "pipelinevariable", "whatif", "confirm"]);
  for (const name of Object.keys(parameters)) {
    const metadata = help.parameters.find(p => p.name.toLowerCase() === name.toLowerCase() || p.aliases.some(a => a.toLowerCase() === name.toLowerCase()));
    const canonical = metadata?.name ?? name;
    if (remote && !metadata && name.toLowerCase() !== "sqlcredential" && !common.has(name.toLowerCase())) throw new Error("HTTPS requires documented full parameter names or documented aliases; abbreviations are not accepted");
    if (used.has(canonical.toLowerCase())) throw new Error("Duplicate parameter or alias");
    used.add(canonical.toLowerCase());
    const value = parameters[name];
    const looksLikeCredential = value && typeof value === "object" && Object.keys(value).some(key => /^(password|username)$/i.test(key));
    if (remote && (credentialKeys.has(name.toLowerCase()) || looksLikeCredential)) {
      throw new Error("HTTPS credential parameters require credentialRefs; inline credentials are not accepted");
    }
  }
  for (const [name, alias] of Object.entries(refs)) {
    if (!names.some(n => n.toLowerCase() === name.toLowerCase())) throw new Error(`Not a documented credential parameter: ${name}`);
    credentialAlias.parse(alias);
    if (used.has(name.toLowerCase())) throw new Error("A credential parameter cannot be both inline and referenced");
    used.add(name.toLowerCase());
  }
  return [...credentialKeys];
}

export function fileCredentialResolver(config: ServerConfig): CredentialResolver {
  return async (refs, principal) => {
    if (!Object.keys(refs).length) return {};
    if (process.platform !== "win32") throw new Error("DPAPI credential profiles require Windows");
    const directory = process.env.DBATOOLS_CREDENTIAL_STORE;
    if (!directory) throw new Error("Configure DBATOOLS_CREDENTIAL_STORE for credential references");
    const root = await realpath(directory);
    const manifestPath = resolve(root, "profiles.json");
    const checkedManifest = await helperJson<{ ok: boolean }>(config, "check-credential-acl.ps1", { paths: [root, manifestPath] });
    if (!checkedManifest.ok) throw new Error("Credential store ACLs must allow only the executing account, SYSTEM, and Administrators");
    const profiles = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    const files: Record<string, string> = {};
    for (const [name, alias] of Object.entries(refs)) {
      const profile = Object.hasOwn(profiles, alias) ? profiles[alias] : undefined;
      if (!profile) throw new Error(`Credential profile '${alias}' was not found`);
      if (principal.kind === "local" ? !profile.allowLocal : !profile.allowedSids.includes(principal.sid)) throw new AccessError(403, "Credential profile is not permitted for this caller");
      if (isAbsolute(profile.file)) throw new Error("Credential file must be relative to its store");
      const path = await realpath(resolve(root, profile.file));
      const rel = relative(root, path);
      if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Credential file must remain inside its store");
      const checked = await helperJson<{ ok: boolean }>(config, "check-credential-acl.ps1", { paths: [path] });
      if (!checked.ok) throw new Error("Credential file has unsafe ACLs");
      files[name] = path;
    }
    return files;
  };
}

export function redact(text: string, parameters: Record<string, unknown>): string {
  const secrets: string[] = [];
  function visit(value: unknown, key = "") {
    if (typeof value === "string" && /password|secret|token|connectionstring/i.test(key) && value) secrets.push(value);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, k);
  }
  visit(parameters);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    for (const variant of [JSON.stringify(secret).slice(1, -1), secret]) text = text.split(variant).join("[REDACTED]");
  }
  return text;
}
