# Repository Agent Instructions

- Work, commit, and push only on `development`. Never commit or push directly to `main`.
- The user handles the `development` to `main` pull request manually.
- Preserve STDIO compatibility when changing HTTPS, authentication, or credentials.
- Keep secrets out of command arguments, logs, tests, and repository files.
- Run the available automated checks and report Windows acceptance tests separately when Windows is unavailable.

## Project context

- This is a TypeScript/Node.js MCP wrapper around the installed dbatools PowerShell module. SQL work runs on the MCP host, targeting local or remote SQL instances.
- Default transport is STDIO. Optional HTTPS uses stateless Streamable HTTP at `/mcp`; Windows login issues opaque bearer sessions. Remote sign-in does not impersonate the caller.
- `src/server-factory.ts` owns the four tools and help resources. `src/tool-registry.ts` builds command scripts; values/credentials travel separately on stdin.
- `scripts/run-command.ps1` is the shared one-shot/persistent driver. `scripts/serialize-output.ps1` converts output into bounded plain JSON before serialization.
- DPAPI profiles hold command credentials on the Windows host; MCP login tokens and command credentials are distinct.
- HTTPS session lifetime is configured at startup by DBATOOLS_SESSION_TTL_SECONDS (60–86400 whole seconds, default 3600). The POC opts into 86400. Expiration is absolute and all tokens still invalidate on MCP restart.

## Output handling and regression checks

- Never pass raw DataRow, DataTable, or SMO object graphs to ConvertTo-Json. Table results must contain column/value data rather than .NET table metadata.
- Preserve optional selectProperties. SQL column names containing underscores are valid; expressions, wildcards, and PowerShell syntax are not.
- Keep explicit bounds on nesting, collections, text, and total output. Mark omitted/truncated values and report limit errors without retrying commands that may have already changed state.
- Avoid executing ScriptProperty getters or expanding complex CLR getters during normalization. Preserve credential redaction and process isolation.
- Run `npm test` and `npm run typecheck`. With PowerShell 7 installed, `tests/serialization.test.mjs` exercises the real driver using synthetic objects, without requiring SQL. Set PWSH_EXE if needed.
- Run `npm run test:windows` only with the documented disposable Windows accounts. The Windows CI workflow also verifies persistent serialization, authentication, DPAPI and ACLs.
- Live POC observations: unrestricted instance-property serialization exhausted memory; an Invoke-DbaQuery DataRow expanded to roughly 568 KB for two values. These are wrapper serialization regressions to prevent.
- `docs/dbatools-mcp-https-deployment-guide.md` records the verified Windows/Linux POC and operational handoff; distinguish confirmed tests from pending Agent SDK application work.
- Keep its PDF synchronized when updating the guide, using `scripts/build-deployment-guide.py` on a documentation build machine. Never include real passwords, tokens, or private keys in examples.
