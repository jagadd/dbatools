$ErrorActionPreference = "Stop"
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($currentSid, "S-1-5-18", "S-1-5-32-544")
$ok = $true
foreach ($path in $request.paths) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $ok = $false; break }
    $acl = Get-Acl -LiteralPath $path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $allowed) { $ok = $false; break }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq "Allow" -and $rule.IdentityReference.Value -notin $allowed -and [int]$rule.FileSystemRights -ne 0) {
            $ok = $false
        }
    }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $ok } -Compress))
