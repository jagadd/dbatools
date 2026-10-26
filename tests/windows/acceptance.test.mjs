import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { windowsValidator } from '../../dist/auth.js';
import { runPowerShell } from '../../dist/powershell.js';
import { PersistentSession } from '../../dist/powershell-session.js';
import { fileCredentialResolver } from '../../dist/credentials.js';
import { helperPath } from '../../dist/child-process.js';
import { config } from '../fixtures.mjs';

test('Windows native acceptance: logon, service identity, DPAPI, ACLs, stdin and persistent queue', async t=>{
  try {
  assert.equal(process.platform,'win32','Windows acceptance requires Windows; it must not silently skip');
  const operator=process.env.DBATOOLS_TEST_OPERATOR_USER;
  const reader=process.env.DBATOOLS_TEST_READER_USER;
  const outsider=process.env.DBATOOLS_TEST_OUTSIDER_USER;
  const password=process.env.DBATOOLS_TEST_LOGIN_PASSWORD;
  assert.ok(operator&&reader&&outsider&&password,'Configure the three test accounts and DBATOOLS_TEST_LOGIN_PASSWORD; see docs/https.md');
  const currentConfig={...config,powershellExe:process.env.PWSH_EXE??'pwsh',usePersistentSession:false};
  const validate=windowsValidator(currentConfig);
  const op=await validate(operator,password);
  assert.ok(op.roles.includes('operator'));
  assert.deepEqual((await validate(reader,password)).roles,['reader']);
  await assert.rejects(validate(outsider,password),e=>e.status===403);
  await assert.rejects(validate(operator,'synthetic-wrong-password'),e=>e.status===401);
  const identity=await runPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().Name | ConvertTo-Json -Compress',currentConfig);
  assert.equal(identity.exitCode,0);
  assert.notEqual(JSON.parse(identity.stdout).toLowerCase(),operator.toLowerCase(),'Sign-in must not impersonate the operator');

  const synthetic="synthetic'\"Password42";
  const reflected=await runPowerShell("(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $PID)).CommandLine | ConvertTo-Json -Compress",currentConfig,{parameters:{SqlCredential:{username:'fixture',password:synthetic}},credentialParameters:['SqlCredential']});
  assert.ok(!reflected.stdout.includes(synthetic));
  assert.ok(!reflected.stdout.includes('EncodedCommand'));
  const redacted=await runPowerShell('throw $request.parameters.SqlCredential.GetNetworkCredential().Password',currentConfig,{parameters:{SqlCredential:{username:'fixture',password:synthetic}},credentialParameters:['SqlCredential']});
  assert.equal(redacted.exitCode,1);
  assert.ok(redacted.stderr.includes('[REDACTED]'));
  assert.ok(!redacted.stderr.includes(synthetic));

  const directory=await mkdtemp(join(tmpdir(),'dbatools-dpapi-'));
  const oldStore=process.env.DBATOOLS_CREDENTIAL_STORE;
  const oldModules=process.env.PSModulePath;
  t.after(async()=>{
    if(oldStore===undefined)delete process.env.DBATOOLS_CREDENTIAL_STORE;else process.env.DBATOOLS_CREDENTIAL_STORE=oldStore;
    if(oldModules===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=oldModules;
    await rm(directory,{recursive:true,force:true});
  });
  const credentialPath=join(directory,'lab.clixml');
  const manifestPath=join(directory,'profiles.json');
  await writeFile(manifestPath,JSON.stringify({lab:{file:'lab.clixml',allowedSids:[op.sid],allowLocal:true}}));
  const setup=await runPowerShell([
    '. $request.parameters.AclScript',
    '$request.parameters.SqlCredential | Export-Clixml -LiteralPath $request.parameters.File',
    'Set-McpPrivateAcl -Path $request.parameters.Root -Directory',
    'Set-McpPrivateAcl -Path $request.parameters.File',
    'Set-McpPrivateAcl -Path $request.parameters.Manifest',
    "Write-Output '{}'",
  ].join('\n'),currentConfig,{parameters:{SqlCredential:{username:'fixture',password:synthetic},File:credentialPath,Root:directory,Manifest:manifestPath,AclScript:helperPath('acl.ps1')},credentialParameters:['SqlCredential']});
  assert.equal(setup.exitCode,0,setup.stderr);
  process.env.DBATOOLS_CREDENTIAL_STORE=directory;
  const resolver=fileCredentialResolver(currentConfig);
  assert.deepEqual(await resolver({SqlCredential:'lab'},op),{SqlCredential:credentialPath});
  await assert.rejects(resolver({SqlCredential:'lab'},{...op,sid:'S-1-5-21-1-2-3-9999'}),e=>e.status===403);
  await assert.rejects(resolver({SqlCredential:'missing'},op),/not found/);
  const stored=await runPowerShell('$request.parameters.SqlCredential.GetNetworkCredential().Password',currentConfig,{credentialFiles:{SqlCredential:credentialPath}});
  assert.ok(stored.stdout.includes('[REDACTED]'));
  assert.ok(!stored.stdout.includes(synthetic));
  const loosen=await runPowerShell('$acl=Get-Acl -LiteralPath $request.parameters.File; $sid=New-Object Security.Principal.SecurityIdentifier("S-1-1-0"); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,"Read","Allow"))); Set-Acl -LiteralPath $request.parameters.File -AclObject $acl; Write-Output "{}"',currentConfig,{parameters:{File:credentialPath}});
  assert.equal(loosen.exitCode,0,loosen.stderr);
  await assert.rejects(resolver({SqlCredential:'lab'},op),/unsafe ACL/);

  // A harmless local module fixture proves driver lifecycle without touching SQL.
  const modules=join(directory,'modules');
  await mkdir(join(modules,'dbatools'),{recursive:true});
  await writeFile(join(modules,'dbatools','dbatools.psm1'),'# Test fixture: deliberately no SQL commands\n');
  process.env.PSModulePath=modules+(oldModules?delimiter+oldModules:'');
  const session=new PersistentSession();t.after(()=>session.shutdown());
  const persistentConfig={...currentConfig,usePersistentSession:true,commandTimeout:2};
  const first=session.run('Start-Sleep -Milliseconds 100; Write-Output "first"',persistentConfig);
  const second=session.run('Write-Output "second"',persistentConfig);
  assert.equal((await first).stdout.trim(),'first');
  assert.equal((await second).stdout.trim(),'second');
  await assert.rejects(session.run('Start-Sleep -Seconds 5',persistentConfig),/timed out/);
  assert.equal((await session.run('Write-Output "recovered"',persistentConfig)).stdout.trim(),'recovered');
  } catch (error) {
    if (process.env.RUNNER_TEMP) {
      let detail = error.stack ?? String(error);
      for (const value of [process.env.DBATOOLS_TEST_LOGIN_PASSWORD, "synthetic'\"Password42"]) if (value) detail = detail.split(value).join('[REDACTED]');
      await writeFile(join(process.env.RUNNER_TEMP, 'mcp-acceptance-failure.txt'), detail, {mode:0o600});
    }
    throw error;
  }
});
