function Set-McpPrivateAcl {
    param([string]$Path, [switch]$Directory)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($Directory) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
    } else {
        $acl = New-Object Security.AccessControl.FileSecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($allowed in @($sid, (New-Object Security.Principal.SecurityIdentifier("S-1-5-18")), (New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")))) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($allowed, "FullControl", $inheritance, "None", "Allow")
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
