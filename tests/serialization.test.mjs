import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import { helperPath } from '../dist/child-process.js';
import { buildPowerShellScript } from '../dist/tool-registry.js';

const executable = process.env.PWSH_EXE ?? 'pwsh';
const available = isAbsolute(executable) ? existsSync(executable) :
  (process.env.PATH ?? process.env.Path ?? '').split(delimiter).some(dir => existsSync(join(dir, executable + (process.platform === 'win32' ? '.exe' : ''))));
const options = {skip: !available && process.platform !== 'win32' ? 'PowerShell 7 is not installed' : false};

async function execute(setup, {properties} = {}) {
  const script = setup + '\n' + buildPowerShellScript('Get-TestOutput', {}, 100, properties, {skipImport:true});
  const input = JSON.stringify({id:'test', script, parameters:{}, credentialFiles:{}, credentialParameters:[]}) + '\n';
  const output = await new Promise((resolve, reject) => {
    const child=spawn(executable, ['-NonInteractive','-NoProfile','-File',helperPath('run-command.ps1')]);
    let stdout='', stderr='';
    const timer=setTimeout(()=>{child.kill(); reject(new Error('PowerShell fixture timed out'));},30000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>2*1024*1024){child.kill();reject(new Error('Fixture output exceeded limit'));}});
    child.stderr.on('data',chunk=>stderr+=chunk.toString());
    child.stdin.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(stderr || `PowerShell exited ${code}`));else resolve(stdout);});
    child.stdin.end(input);
  });
  const lines = output.trim().split(/\r?\n/);
  return JSON.parse(Buffer.from(lines[0], 'base64').toString('utf8'));
}

test('actual driver converts DataRow columns, DBNull, dates and multiple rows to plain JSON', options, async () => {
  const response = await execute(`function Get-TestOutput {
    $table = [Data.DataTable]::new()
    [void]$table.Columns.Add('total_memory_kb', [long])
    [void]$table.Columns.Add('Optional', [string])
    [void]$table.Columns.Add('When', [datetime])
    [void]$table.Rows.Add(4137684, [DBNull]::Value, [datetime]'2026-10-29T08:00:00Z')
    [void]$table.Rows.Add(710644, 'value', [datetime]'2026-10-29T08:00:00Z')
    $table.Rows
  }`);
  assert.equal(response.exitCode,0,response.stderr);
  const rows=JSON.parse(response.stdout);
  assert.equal(rows.length,2);
  assert.deepEqual(Object.keys(rows[0]),['total_memory_kb','Optional','When']);
  assert.equal(rows[0].total_memory_kb,4137684);
  assert.equal(rows[0].Optional,null);
  assert.match(rows[0].When,/^2026-10-29T08:00:00/);
  assert.ok(response.stdout.length<500);
});

test('actual driver preserves singleton and empty results and supports underscore selection', options, async () => {
  const response=await execute('function Get-TestOutput { [pscustomobject]@{total_memory_kb=42; Other="value"} }', {properties:['total_memory_kb']});
  assert.equal(response.exitCode,0,response.stderr);
  assert.deepEqual(JSON.parse(response.stdout),{total_memory_kb:42});
  const empty=await execute('function Get-TestOutput {}');
  assert.equal(empty.exitCode,0,empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout),[]);
});

test('actual driver avoids complex CLR getters and ScriptProperty execution', options, async () => {
  const response=await execute(`Add-Type 'public class McpOutputFixture {
    public string Name { get { return "fixture"; } }
    public object Parent { get { throw new System.Exception("must not read parent"); } }
  }'
  function Get-TestOutput {
    $value = [McpOutputFixture]::new()
    $value | Add-Member ScriptProperty Dangerous { throw 'must not evaluate script property' }
    $value
  }`);
  assert.equal(response.exitCode,0,response.stderr);
  assert.deepEqual(JSON.parse(response.stdout),{Name:'fixture'});
});

test('actual driver bounds cycles and redacts credential objects', options, async () => {
  const response=await execute(`function Get-TestOutput {
    $value = [pscustomobject]@{Name='fixture'}
    $value | Add-Member NoteProperty Parent $value
    $value | Add-Member NoteProperty Credential ([pscredential]::new('fixture', (ConvertTo-SecureString 'synthetic-output-secret' -AsPlainText -Force)))
    $value
  }`);
  assert.equal(response.exitCode,0,response.stderr);
  assert.match(response.stdout,/MCP omitted nested object/);
  assert.ok(!response.stdout.includes('synthetic-output-secret'));
  assert.equal(JSON.parse(response.stdout).Credential,'[REDACTED]');
  assert.ok(response.stdout.length<1000);
});

test('actual driver rejects excessive output before raw object serialization', options, async () => {
  const response=await execute(`function Get-TestOutput {
    $value = [ordered]@{}
    foreach ($i in 1..30) { $value["Field$i"] = 'x' * 10000 }
    $value
  }`);
  assert.equal(response.exitCode,1);
  assert.match(response.stderr,/serialization text limit/);
  assert.equal(response.stdout,'');
});

test('actual driver labels truncation and bounds nested collections', options, async () => {
  const response=await execute(`function Get-TestOutput {
    [pscustomobject]@{Text=('x' * 10000); Values=@(1); State=[DayOfWeek]::Monday}
  }`);
  assert.equal(response.exitCode,0,response.stderr);
  const value=JSON.parse(response.stdout);
  assert.match(value.Text,/\[MCP truncated string\]$/);
  assert.deepEqual(value.Values,[1]);
  assert.equal(value.State,'Monday');
  const excessive=await execute('function Get-TestOutput { [pscustomobject]@{Values=@(1..101)} }');
  assert.equal(excessive.exitCode,1);
  assert.match(excessive.stderr,/more than 100 items/);
});

test('output selection accepts SQL underscores but rejects PowerShell expressions', () => {
  for(const name of ['Name;exit', 'Parent.Name', '*', '$(Get-Process)']) {
    assert.throws(()=>buildPowerShellScript('Get-TestOutput',{},100,[name]),/Invalid property name/);
  }
});
