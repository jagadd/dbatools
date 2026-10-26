$ErrorActionPreference = "Stop"
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
. (Join-Path $PSScriptRoot "acl.ps1")
Set-McpPrivateAcl -Path $request.path -Directory:$request.directory
[Console]::Out.WriteLine('{"ok":true}')
