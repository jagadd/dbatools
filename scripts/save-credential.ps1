param(
    [Parameter(Mandatory)][string]$Store,
    [Parameter(Mandatory)][ValidatePattern("^[A-Za-z][A-Za-z0-9_-]{0,63}$")][string]$Alias,
    [ValidatePattern("^S-1-\d+(-\d+)+$")][string[]]$AllowedSids = @(),
    [switch]$AllowLocal,
    [switch]$AsSecret
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows) { throw "DPAPI profiles must be created on Windows under the executing account" }
. (Join-Path $PSScriptRoot "acl.ps1")
$null = New-Item -Path $Store -ItemType Directory -Force
Set-McpPrivateAcl -Path $Store -Directory
$Store = (Resolve-Path -LiteralPath $Store).Path
$manifestPath = Join-Path $Store "profiles.json"
if (Test-Path -LiteralPath $manifestPath) {
    $profiles = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
} else { $profiles = @{} }
if ($profiles.ContainsKey($Alias)) { throw "That profile alias already exists; remove it deliberately before replacing its credential" }
if ($AsSecret) { $value = Read-Host -Prompt "Secret" -AsSecureString }
else { $value = Get-Credential -Message "Credential to encrypt for profile $Alias (not the MCP login account)" }
if ($null -eq $value) { throw "Credential entry cancelled" }
$fileName = $Alias + ".clixml"
$credentialPath = Join-Path $Store $fileName
if (Test-Path -LiteralPath $credentialPath) { throw "Credential file already exists" }
$value | Export-Clixml -LiteralPath $credentialPath
Set-McpPrivateAcl -Path $credentialPath
$profiles[$Alias] = @{
    file        = $fileName
    allowedSids = @($AllowedSids)
    allowLocal  = [bool]$AllowLocal
}
ConvertTo-Json -InputObject $profiles -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Set-McpPrivateAcl -Path $manifestPath
Write-Host "Saved profile $Alias for the current Windows account. No password was printed."
