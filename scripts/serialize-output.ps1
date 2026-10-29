# Convert command output to plain, bounded data before invoking ConvertTo-Json.
# In particular, never serialize DataRow.Table or recursively walk SMO parents.
function Test-McpScalarType {
    param([type]$Type)
    return $Type.IsPrimitive -or $Type.IsEnum -or $Type -in @(
        [string], [decimal], [datetime], [datetimeoffset], [timespan], [guid], [version]
    )
}

function ConvertTo-McpValue {
    param([AllowNull()][object]$Value, [int]$Depth, [hashtable]$Budget)
    $Budget.Nodes++
    if ($Budget.Nodes -gt 5000) { throw 'Output exceeds the serialization node limit; select fewer properties or rows.' }
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    if ($Value -is [Management.Automation.PSCredential] -or $Value -is [Security.SecureString]) { return '[REDACTED]' }
    $type = $Value.GetType()
    if ($Value -is [string]) {
        if ($Value.Length -gt 8192) { $Value = $Value.Substring(0, 8192) + '[MCP truncated string]' }
        $Budget.Characters += $Value.Length
        if ($Budget.Characters -gt 131072) { throw 'Output exceeds the serialization text limit; select fewer properties or rows.' }
        return $Value
    }
    if ($Value -is [datetime] -or $Value -is [datetimeoffset]) { return $Value.ToString('o') }
    if ($type.IsEnum -or $Value -is [guid] -or $Value -is [timespan] -or $Value -is [version]) { return $Value.ToString() }
    if ($type.IsPrimitive -or $Value -is [decimal]) { return $Value }
    if ($Depth -ge 3) { return '[MCP omitted nested object]' }
    if ($Value -is [byte[]]) {
        if ($Value.Length -gt 4096) { return '[MCP omitted binary value larger than 4096 bytes]' }
        return ConvertTo-McpValue ([Convert]::ToBase64String($Value)) ($Depth + 1) $Budget
    }

    $result = [ordered]@{}
    if ($Value -is [Data.DataRow]) {
        # Read cells by schema, excluding RowState, Table, ItemArray, etc.
        foreach ($column in $Value.Table.Columns) {
            if ($result.Count -ge 128) { throw 'Output has more than 128 columns; select fewer properties.' }
            $Budget.Characters += $column.ColumnName.Length
            $result[$column.ColumnName] = ConvertTo-McpValue $Value[$column] ($Depth + 1) $Budget
        }
        return $result
    }
    if ($Value -is [Data.DataTable]) { $Value = $Value.Rows }
    elseif ($Value -is [Data.DataSet]) { $Value = $Value.Tables }

    if ($Value -is [Collections.IDictionary]) {
        foreach ($key in $Value.Keys) {
            if ($result.Count -ge 128) { throw 'Output has more than 128 keys; select fewer properties.' }
            if ($key -isnot [string]) { throw 'Output dictionary keys must be strings.' }
            $Budget.Characters += $key.Length
            $result[$key] = ConvertTo-McpValue $Value[$key] ($Depth + 1) $Budget
        }
        return $result
    }
    if ($Value -is [Collections.IEnumerable]) {
        # Do not enumerate arbitrary CLR/SMO collections: enumeration can load data.
        if ($Value -isnot [array] -and $Value -isnot [Collections.IList] -and
            $Value -isnot [Data.DataRowCollection] -and $Value -isnot [Data.DataTableCollection]) {
            return '[MCP omitted collection; select specific properties]'
        }
        $values = [Collections.Generic.List[object]]::new()
        foreach ($item in $Value) {
            if ($values.Count -ge 100) { throw 'Nested output has more than 100 items; select fewer properties.' }
            $values.Add((ConvertTo-McpValue $item ($Depth + 1) $Budget))
        }
        return ,($values.ToArray())
    }
    # Nested CLR objects can expose lazy getters, parents and cycles. Only plain
    # objects/dictionaries recurse; a top-level CLR object gets scalar fields.
    if ($Depth -gt 0 -and $Value -isnot [pscustomobject]) {
        return '[MCP omitted complex object; select specific properties]'
    }
    foreach ($property in $Value.PSObject.Properties) {
        if ($result.Count -ge 128) { $result['_McpTruncated'] = 'More than 128 properties; use selectProperties.'; break }
        if ($property.MemberType -eq 'NoteProperty') {
            $cell = $property.Value
        } elseif ($property.MemberType -eq 'Property') {
            # Check declared types before reading getters, rather than triggering
            # SMO lazy collection/parent getters and discarding their values later.
            $declared = $type.GetProperty($property.Name, [Reflection.BindingFlags]'Public,Instance')
            if ($null -eq $declared -or $declared.GetIndexParameters().Length -gt 0 -or
                -not (Test-McpScalarType $declared.PropertyType)) { continue }
            try { $cell = $property.Value } catch { $result[$property.Name] = '[MCP property unavailable]'; continue }
        } else { continue } # Never evaluate ScriptProperty/AliasProperty getters.
        $Budget.Characters += $property.Name.Length
        $result[$property.Name] = ConvertTo-McpValue $cell ($Depth + 1) $Budget
    }
    return $result
}

function ConvertTo-McpJson {
    param([AllowNull()][object]$InputObject)
    $budget = @{ Nodes = 0; Characters = 0 }
    # A row's position in the top-level result array does not consume nesting depth.
    if ($null -eq $InputObject) { return '[]' }
    if ($InputObject -is [array]) {
        $rows = [Collections.Generic.List[object]]::new()
        foreach ($row in $InputObject) { $rows.Add((ConvertTo-McpValue $row 0 $budget)) }
        $plain = $rows.ToArray()
    } else { $plain = ConvertTo-McpValue $InputObject 0 $budget }
    if ($budget.Characters -gt 131072) { throw 'Output exceeds the serialization text limit; select fewer properties or rows.' }
    $json = ConvertTo-Json -InputObject $plain -Depth 12 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 1048576) {
        throw 'Serialized output exceeds 1 MB; select fewer properties or rows.'
    }
    return $json
}
