$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ sid = $identity.User.Value } -Compress))
} finally { $identity.Dispose() }
