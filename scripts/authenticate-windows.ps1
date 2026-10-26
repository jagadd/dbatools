$ErrorActionPreference = "Stop"
$inputData = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
$handle = [IntPtr]::Zero
try {
    # Validate only this host's SAM accounts; this POC does not perform domain login.
    $parts = $inputData.username -split "\\", 2
    if ($parts.Count -ne 2 -or $parts[0] -ine $env:COMPUTERNAME -or [string]::IsNullOrWhiteSpace($parts[1])) {
        [Console]::Out.WriteLine('{"ok":false,"status":401}')
        exit 0
    }
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class McpWindowsLogon {
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool LogonUser(string name, string domain, string password, int type, int provider, out IntPtr token);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr token);
}
"@
    $valid = [McpWindowsLogon]::LogonUser($parts[1], $env:COMPUTERNAME, $inputData.password, 3, 0, [ref]$handle)
    if (-not $valid) {
        [Console]::Out.WriteLine('{"ok":false,"status":401}')
        exit 0
    }
    $identity = New-Object Security.Principal.WindowsIdentity($handle)
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        $roles = @()
        foreach ($mapping in @(@("McpReaders", "reader"), @("McpOperators", "operator"))) {
            try {
                $account = New-Object Security.Principal.NTAccount($env:COMPUTERNAME, $mapping[0])
                $sid = $account.Translate([Security.Principal.SecurityIdentifier])
                if ($principal.IsInRole($sid)) { $roles += $mapping[1] }
            } catch [Security.Principal.IdentityNotMappedException] { }
        }
        if ($roles.Count -eq 0) {
            [Console]::Out.WriteLine('{"ok":false,"status":403}')
        } else {
            $result = @{ ok = $true; sid = $identity.User.Value; roles = @($roles) }
            [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
        }
    } finally { $identity.Dispose() }
} finally {
    if ($handle -ne [IntPtr]::Zero) { $null = [McpWindowsLogon]::CloseHandle($handle) }
    $inputData = $null
}
