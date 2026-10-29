# Windows HTTPS and STDIO setup

The same TypeScript tool/resource implementation serves both transports. The
default remains STDIO. HTTPS is Streamable HTTP at `/mcp`, not the legacy SSE
transport. No SQL provisioning workflows or remote execution workers are added.

## Requirements and process identity

Use Node 20+, PowerShell 7+ (`pwsh`), dbatools, and a generated help index on the
Windows MCP host. Build with `npm ci` and `npm run build`. Run
`npm run refresh-help` **under the account that will execute the server**, so its
module installation and help index agree. `DBATOOLS_HELP_INDEX` can specify an
absolute manifest path; otherwise `generated/dbatools-help.json` is used.

For the POC, first run Node in a terminal logged in as your chosen dedicated
execution account. All HTTPS PowerShell children inherit that account. Windows
login identifies/authorizes the caller; it does **not** impersonate that caller.
If you later install Node as a Windows service, use an approved service manager
that runs it as the same account and loads its user profile. `node.exe` itself is
not an SCM service executable. Do not change service accounts without recreating
their DPAPI credential profiles.

STDIO instead runs as whichever account launches `node dist/server.js`. It needs
no additional MCP login, and does not expose a network listener.

## Authorize local Windows accounts

In an elevated PowerShell terminal, create the authorization groups:

```powershell
New-LocalGroup -Name McpReaders
New-LocalGroup -Name McpOperators
Add-LocalGroupMember -Group McpReaders -Member "SERVER\reader"
Add-LocalGroupMember -Group McpOperators -Member "SERVER\operator"
```

Create the users through your normal Windows account-management process. Use
existing dedicated accounts if appropriate. They need the Windows right to log
on from the network for `LogonUser` network logon. Domain accounts are outside
this POC: login names must be `SERVER\username`, where SERVER is the MCP host's
computer name. An account needs membership in at least one of the two groups.

Readers may list/search commands, read help/resources, and inspect the
environment. Operators may also invoke indexed commands. The existing safe-mode
`confirm:true` requirement still applies after operator authorization. Risk
annotations and confirmation do not grant permissions.

## Configure HTTPS

Obtain a PEM certificate and private key with the MCP hostname in the certificate
SAN, and a chain trusted by the client. Include intermediate certificates in the
certificate PEM when needed. Restrict private-key access to the service account,
SYSTEM, and Administrators. Keep keys and credential stores outside the checkout.

In the execution account's terminal:

```powershell
$env:DBATOOLS_TRANSPORT = "https"
$env:DBATOOLS_HTTPS_HOST = "0.0.0.0"
$env:DBATOOLS_HTTPS_PORT = "8443"
$env:DBATOOLS_HTTPS_ALLOWED_HOSTS = "mcp.example.internal"
$env:DBATOOLS_TLS_CERT_FILE = "C:\McpConfig\server-chain.pem"
$env:DBATOOLS_TLS_KEY_FILE = "C:\McpConfig\server-key.pem"
$env:DBATOOLS_CREDENTIAL_STORE = "C:\McpConfig\credentials"
node dist/server.js
```

Allow inbound TCP 8443 only from your POC management network. The bind address
defaults to `127.0.0.1`, so explicitly choose an interface for remote access.
Allowed hosts are comma-separated exact hostnames without schemes, ports, or
wildcards. List IP addresses too if clients will address the host by IP and the
certificate supports those IPs. HTTPS has no unencrypted fallback.

Native MCP clients usually send no Origin header. If using a browser client,
configure `DBATOOLS_HTTPS_ALLOWED_ORIGINS` with exact approved origins. Other
Origin values are rejected. Browser CORS integration is not included in this
POC; use a direct HTTPS MCP client or STDIO client.

## Remote login and client configuration

Run from the client machine:

```powershell
node dist/server.js login --url "https://mcp.example.internal:8443" --ca "C:\McpConfig\lab-ca.pem"
```

Omit `--ca` when the issuer is already trusted by Node. The helper prompts for the
Windows username and hides password input. It saves only the opaque session
token, server origin, and expiration to a private file under
`~/.dbatools-mcp/sessions/`; it prints the file path, not the token. Passwords are
never accepted in CLI arguments or stored in that file.

Use the saved token in your client's **secret input** as
`Authorization: Bearer <session-token>`. See `.vscode/mcp-https.example.json`.
For a lab CA, configure that client's trusted CA too; Node clients can use
`NODE_EXTRA_CA_CERTS`. Never disable TLS verification. Do not paste passwords or
tokens into an AI conversation, commit them, or put them in an MCP tool call.

Sessions last one hour. Run login again and update the client secret after
expiration or server restart. `POST /auth/logout` with the Authorization header
revokes that token. Sessions are memory-only, with only token hashes stored on
the server. Group changes take effect at the next login (or invalidate all
sessions by restarting the service). Login is limited to five attempts per
source address per 15 minutes; normal Windows account-lockout policy also applies.

This is custom POC session authentication, not an OAuth provider. It requires an
MCP client that accepts a custom Authorization header; it does not implement
automatic browser OAuth sign-in or advertise OAuth metadata.

## Credential profiles

MCP login credentials are separate from credentials used by a command. To create
a profile, run this **on the server, under the executing service account**:

```powershell
$splatProfile = @{
    Store       = "C:\McpConfig\credentials"
    Alias       = "lab-account"
    AllowedSids = @("S-1-5-21-REPLACE-WITH-CALLER-SID")
}
.\scripts\save-credential.ps1 @splatProfile
```

Replace the sample SID with a real caller SID, obtained through Windows account
management. The script prompts for the command credential, encrypts it using
the executing account's DPAPI key, creates `profiles.json`, and sets restrictive
ACLs. Use `-AllowLocal` to permit that account's STDIO process too. Use
`-AsSecret` for a documented SecureString parameter instead of PSCredential.
Neither option puts the secret in command arguments.

Example invocation:

```json
{
  "commandName": "Get-DbaDatabase",
  "parameters": { "SqlInstance": "sql.example.internal" },
  "credentialRefs": { "SqlCredential": "lab-account" }
}
```

Profiles name local encrypted files and list the Windows SIDs permitted to use
them. Client-supplied paths are never accepted. Credential references must name
documented credential parameters. Inline and referenced values for the same
parameter are rejected, including parameter aliases. HTTPS rejects inline
credential parameters entirely. STDIO retains legacy inline SqlCredential
support, but references keep passwords out of the conversation.

STDIO uses a credential store owned/encrypted by its launching account; it does
not gain access to another account's service store. Profiles cannot simply be
copied to another machine/account and decrypted. Recreate them there.

## Execution, diagnostics, and limits

HTTPS always uses one fresh PowerShell process per invocation, with at most two
executions active (including environment checks). Excess work receives a tool
error saying that no command was started; there is no automatic retry. A client
disconnect is not a guarantee that a started command stopped. Treat failed
mutating commands as having an uncertain outcome before attempting a retry.

STDIO retains the configurable persistent process and serializes its requests.
Timeouts start when execution begins, not while waiting for that process.
`DBATOOLS_PERSISTENT_SESSION=false` selects one-shot STDIO execution. HTTPS
ignores that flag and always isolates calls.

Existing output-row and timeout settings remain in effect. All execution data
travels through stdin to a fixed driver, not `-EncodedCommand` arguments.
Credential-profile passwords are redacted inside PowerShell before output leaves
it; legacy inline passwords are also redacted in Node. Arbitrary command output
is not a general-purpose data-loss-prevention filter. Audit JSON on stderr
contains caller SID, command name, request ID, duration, and outcome, not raw
parameters or credential values. STDIO stdout remains reserved for MCP messages.

## Command result serialization

Both transports normalize command results before JSON serialization. DataRow
results contain their column names and cell values (DBNull becomes null), rather
than DataRow/Table/.NET metadata. DataTable and DataSet values use the same bounded
conversion. Scalar CLR properties are included without expanding complex getters;
ScriptProperty getters are not evaluated. Enums become names and dates use ISO
8601 strings. Nested complex CLR values are represented by an explicit omission
marker. This avoids recursively traversing SQL management objects and their parents.

`selectProperties` remains available to choose output fields before normalization.
Names may start with a letter and contain letters, digits, or underscores, so SQL
columns such as `total_physical_memory_kb` are accepted. Expressions and wildcards
are rejected. Select fields belonging to the command's actual return type; missing
fields can still appear as null and are not evidence of command failure.

Normalization limits nesting to three levels, nested collections to 100 items,
objects to 128 properties, and individual strings to 8,192 characters. Truncated
strings/properties and omitted values are marked explicitly. Aggregate limits are
5,000 nodes, 131,072 text characters (including keys), and 1 MB of normalized JSON;
excessive columns, collections or aggregate output return actionable errors asking
for fewer properties or rows. Existing command row/time limits still apply. These
limits bound conversion of the result, not the memory a dbatools command itself
uses before returning it.

A serialization error occurs **after command execution**. For a command that
changes state, verify its actual outcome before considering another invocation;
do not automatically repeat it just because output conversion failed.

## Verification

`npm test` runs native Node tests for real HTTPS/TLS and STDIO protocol behavior,
authorization, session expiry/revocation, credential policy, and execution limits.
Windows TLS fixtures use PowerShell; other systems need OpenSSL for TLS fixtures.
These tests inject authentication/execution fixtures rather than claiming to
prove Windows logon.

`npm run test:windows` requires Windows, PowerShell 7, and three disposable local
accounts: one in McpOperators only, one in McpReaders only, and one in neither.
Supply `DBATOOLS_TEST_OPERATOR_USER`, `DBATOOLS_TEST_READER_USER`,
`DBATOOLS_TEST_OUTSIDER_USER`, and `DBATOOLS_TEST_LOGIN_PASSWORD` using your test
runner's secret environment. All three disposable accounts use the supplied
test password. The tests intentionally make one failed login; do not use
production accounts. Run under an execution account different from these users.
Missing Windows or accounts fails this suite rather than silently skipping it.

The Windows acceptance suite checks native logon and roles, actual process
identity/arguments, redaction, DPAPI, unsafe ACL rejection, and persistent-session
timeout recovery. It uses a harmless module fixture and does not contact SQL.
The Windows GitHub Actions workflow provisions disposable accounts and runs both
suites. Before deployment, also test your actual Windows service identity, CA
chain, help index, and dbatools module installation using the environment tool.
