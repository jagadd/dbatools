param([switch]$Persistent)

$ErrorActionPreference = "Stop"
$WarningPreference = "SilentlyContinue"
$VerbosePreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"
$DebugPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

function Send-Response {
    param([hashtable]$Response)
    $json = ConvertTo-Json -InputObject $Response -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    [Console]::Out.WriteLine([Convert]::ToBase64String($bytes))
    [Console]::Out.Flush()
}

if ($Persistent) {
    try {
        Import-Module dbatools -ErrorAction Stop *>&1 | Out-Null
        Send-Response @{ id = "__ready__"; stdout = "ok"; stderr = ""; exitCode = 0 }
    } catch {
        Send-Response @{ id = "__ready__"; stdout = ""; stderr = "dbatools import failed"; exitCode = 1 }
        exit 1
    }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $requestId = "__unknown__"
    $secrets = New-Object System.Collections.Generic.List[string]
    $response = @{ id = $requestId; stdout = ""; stderr = ""; exitCode = 0 }
    try {
        if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 1048576) { throw "Request exceeds the 1 MB limit" }
        $request = ConvertFrom-Json -InputObject $line -AsHashtable
        $requestId = $request.id
        $response.id = $requestId
        if (-not $request.parameters) { $request.parameters = @{} }
        foreach ($name in @($request.parameters.Keys)) {
            $value = $request.parameters[$name]
            if ($null -eq $value) { $request.parameters.Remove($name); continue }
            if ($name -in $request.credentialParameters -and $value -is [Collections.IDictionary]) {
                if ($value.password -isnot [string] -or $value.username -isnot [string]) { throw "Invalid credential descriptor" }
                $secrets.Add($value.password)
                $secure = ConvertTo-SecureString -String $value.password -AsPlainText -Force
                $request.parameters[$name] = New-Object Management.Automation.PSCredential($value.username, $secure)
            }
        }
        foreach ($entry in $request.credentialFiles.GetEnumerator()) {
            $credential = Import-Clixml -LiteralPath $entry.Value -ErrorAction Stop
            if ($credential -is [Management.Automation.PSCredential]) {
                $secrets.Add($credential.GetNetworkCredential().Password)
            } elseif ($credential -is [Security.SecureString]) {
                $wrapper = New-Object Management.Automation.PSCredential("redaction", $credential)
                $secrets.Add($wrapper.GetNetworkCredential().Password)
            } else { throw "Credential profile must contain a PSCredential or SecureString" }
            $request.parameters[$entry.Key] = $credential
        }
        $items = & {
            param($request)
            & ([scriptblock]::Create($request.script))
        } $request 2>&1 3>&1 4>&1 5>&1 6>&1
        $normal = New-Object System.Collections.Generic.List[object]
        foreach ($item in $items) {
            if ($item -is [Management.Automation.ErrorRecord]) {
                $response.exitCode = 1
                $response.stderr += $item.ToString() + "`n"
            } elseif ($item -is [Management.Automation.InformationalRecord] -or $item -is [Management.Automation.InformationRecord]) {
                $response.stderr += $item.ToString() + "`n"
            } else { $normal.Add($item) }
        }
        $response.stdout = ($normal | Out-String)
    } catch {
        $response.exitCode = 1
        $response.stderr = $_.Exception.Message
    }
    foreach ($secret in $secrets) {
        if ([string]::IsNullOrEmpty($secret)) { continue }
        $encodedSecret = ConvertTo-Json -InputObject $secret -Compress
        $encodedSecret = $encodedSecret.Substring(1, $encodedSecret.Length - 2)
        foreach ($field in "stdout", "stderr") {
            $response[$field] = $response[$field].Replace($encodedSecret, "[REDACTED]").Replace($secret, "[REDACTED]")
        }
    }
    if ([Text.Encoding]::UTF8.GetByteCount($response.stdout + $response.stderr) -gt 10485760) {
        $response.stdout = ""
        $response.stderr = "PowerShell output exceeded the 10 MB limit"
        $response.exitCode = 1
    }
    Send-Response $response
    Remove-Variable request, credential, secure, wrapper, items, normal, value -ErrorAction SilentlyContinue
    $secrets.Clear()
    if (-not $Persistent) { break }
}
