import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server-factory.js';
import { SessionStore, AccessError, getSessionTtlMs } from '../dist/auth.js';
import { validateCredentialInputs, redact } from '../dist/credentials.js';
import { buildPowerShellScript } from '../dist/tool-registry.js';
import { ExecutionLimiter } from '../dist/https-server.js';
import { powerShellEnvironment } from '../dist/child-process.js';
import { parseHelpManifest } from '../dist/help-indexer.js';

import { help, manifest, config, principal } from './fixtures.mjs';

test('PowerShell null, missing and scalar aliases normalize without bypassing credential policy', () => {
  for (const aliases of [null, undefined, [], 'LoginCredential', ['LoginCredential']]) {
    const input = structuredClone(manifest);
    const command = input.commands[help.name];
    for (const parameter of command.parameters) parameter.aliases = null;
    command.parameters.find(p => p.name === 'SqlCredential').aliases = aliases;
    const parsed = parseHelpManifest(JSON.stringify(input)).commands[help.name];
    assert.doesNotThrow(() => validateCredentialInputs(parsed, {SqlInstance: 'localhost'}, {}, true));
    assert.throws(() => validateCredentialInputs(parsed, {SqlCredential: {}}, {}, true), /credentialRefs/);
    if (aliases === 'LoginCredential' || Array.isArray(aliases) && aliases.length) {
      assert.throws(() => validateCredentialInputs(parsed, {LoginCredential: {}}, {}, true), /credentialRefs/);
    }
    assert.ok(parsed.parameters.every(p => Array.isArray(p.aliases)));
  }
  const invalid = structuredClone(manifest);
  invalid.commands[help.name].parameters[0].aliases = [42];
  assert.throws(() => parseHelpManifest(JSON.stringify(invalid)), /Invalid help index aliases/);
});

test('sessions expire, revoke, and do not survive a new store', () => {
  let now=1000;
  const store=new SessionStore(()=>now,100);
  const {token}=store.issue(principal);
  assert.deepEqual(store.authenticate(`Bearer ${token}`),principal);
  assert.throws(()=>new SessionStore().authenticate(`Bearer ${token}`),AccessError);
  now+=100;
  assert.throws(()=>store.authenticate(`Bearer ${token}`),AccessError);
  const second=store.issue(principal).token;
  store.revoke(`Bearer ${second}`);
  assert.throws(()=>store.authenticate(`Bearer ${second}`),AccessError);
});

test('session TTL configuration accepts whole seconds within inclusive limits', t => {
  const previous=process.env.DBATOOLS_SESSION_TTL_SECONDS;
  t.after(()=>{if(previous===undefined)delete process.env.DBATOOLS_SESSION_TTL_SECONDS;else process.env.DBATOOLS_SESSION_TTL_SECONDS=previous;});
  delete process.env.DBATOOLS_SESSION_TTL_SECONDS;
  assert.equal(getSessionTtlMs(),3600000);
  for(const seconds of ['60','3600','86400']) assert.equal(getSessionTtlMs(seconds),Number(seconds)*1000);
  process.env.DBATOOLS_SESSION_TTL_SECONDS='86400';
  assert.equal(getSessionTtlMs(),86400000);
  for(const value of ['', ' ', ' 3600', '3600 ', '59', '86401', '-60', '60.5', '3600.0', '1e3', '0x100', 'Infinity', 'NaN', 'invalid']) {
    assert.throws(()=>getSessionTtlMs(value),/DBATOOLS_SESSION_TTL_SECONDS.*60.*86400/);
  }
});

test('default and 24-hour sessions expire absolutely, revoke, and invalidate on restart', () => {
  for(const ttl of [3600000,getSessionTtlMs('86400')]) {
    let now=1000;
    const store=ttl===3600000 ? new SessionStore(()=>now) : new SessionStore(()=>now,ttl);
    const issued=store.issue(principal);
    assert.equal(issued.expiresAt,now+ttl);
    now+=ttl-1;
    assert.deepEqual(store.authenticate(`Bearer ${issued.token}`),principal);
    assert.deepEqual(store.authenticate(`Bearer ${issued.token}`),principal);
    now++;
    assert.throws(()=>store.authenticate(`Bearer ${issued.token}`),e=>e.status===401);
    const revoked=store.issue(principal).token;
    store.revoke(`Bearer ${revoked}`);
    assert.throws(()=>store.authenticate(`Bearer ${revoked}`),e=>e.status===401);
    const current=store.issue(principal).token;
    assert.throws(()=>new SessionStore(()=>now,ttl).authenticate(`Bearer ${current}`),e=>e.status===401);
    store.clear();
    assert.throws(()=>store.authenticate(`Bearer ${current}`),e=>e.status===401);
  }
});

test('credential policy covers documented credentials, aliases, case and conflicts', () => {
  for (const name of ['SqlCredential','sqlcredential','LoginCredential','Credential','SecurePassword']) {
    assert.throws(()=>validateCredentialInputs(help,{[name]:{username:'fixture',password:'fake'}},{},true),/credentialRefs/);
  }
  assert.throws(()=>validateCredentialInputs(help,{LoginCredential:{}},{SqlCredential:'lab'},false),/both/);
  assert.throws(()=>validateCredentialInputs(help,{}, {Unknown:'lab'},false),/documented/);
  assert.throws(()=>validateCredentialInputs(help,{}, {SqlCredential:'../secret'},false));
  assert.throws(()=>validateCredentialInputs(help,{SqlCredential:{},LoginCredential:{}},{},false),/Duplicate/);
  assert.doesNotThrow(()=>validateCredentialInputs(help,{Credential:{username:'x',password:'fixture'}},{},false));
});

test('password values never become generated PowerShell code; diagnostics redact escaped passwords', () => {
  const password="fake'\"\nSensitive";
  const parameters={SqlCredential:{username:'fixture',password}};
  const script=buildPowerShellScript(help.name,parameters,100);
  assert.ok(!script.includes(password));
  assert.ok(!script.includes('ConvertTo-SecureString'));
  assert.ok(!redact(`error: ${password} ${JSON.stringify(password)}`,parameters).includes('Sensitive'));
});

test('child environment excludes authentication and credential secrets', () => {
  process.env.DBATOOLS_TEST_LOGIN_PASSWORD='fake-password';
  process.env.DBATOOLS_AUTH_TOKEN='fake-token';
  const env=powerShellEnvironment();
  assert.equal(env.DBATOOLS_AUTH_TOKEN,undefined);
  assert.equal(env.DBATOOLS_TEST_LOGIN_PASSWORD,undefined);
  assert.ok(env.PATH || env.Path);
  delete process.env.DBATOOLS_TEST_LOGIN_PASSWORD;
  delete process.env.DBATOOLS_AUTH_TOKEN;
});

test('execution limiter rejects overload and releases capacity after failure', async () => {
  const limiter=new ExecutionLimiter(2);
  let release;
  const wait=new Promise(r=>release=r);
  const execute=limiter.wrap(async script=>{await wait;if(script==='fail')throw new Error('fixture');return {stdout:'[]',stderr:'',exitCode:0};});
  const a=execute('ok',config), b=execute('fail',config);
  await assert.rejects(execute('third',config),/capacity/);
  release(); await a; await assert.rejects(b,/fixture/);
  await execute('next',config);
});

test('server factory preserves tools/resources and supplies credentials out of band', async () => {
  let received;
  const audits=[];
  const server=createServer({config,principal,manifest:()=>manifest,
    checkEnvironment:async()=>({ok:true,version:'2.9.1',identity:'fixture-service'}),
    execute:async(...args)=>{received=args;return {stdout:'[{"Name":"fixture"}]',stderr:'',exitCode:0};},
    resolveCredentials:async()=>({SqlCredential:'C:\\private\\lab.clixml'}),audit:event=>audits.push(event)});
  const [left,right]=InMemoryTransport.createLinkedPair();
  await server.connect(left);
  const client=new Client({name:'test',version:'1'});
  await client.connect(right);
  try {
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['list_dbatools_commands','get_dbatools_command_help','invoke_dbatools_command','check_dbatools_environment']);
    assert.equal((await client.listResources()).resources[0].uri,`dbatools://command/${help.name}`);
    assert.ok((await client.readResource({uri:`dbatools://command/${help.name}`})).contents[0].text.includes(help.name));
    const result=await client.callTool({name:'invoke_dbatools_command',arguments:{commandName:help.name,credentialRefs:{SqlCredential:'lab'},selectProperties:['total_memory_kb']}});
    assert.ok(!result.isError);
    assert.equal(received[2].credentialFiles.SqlCredential,'C:\\private\\lab.clixml');
    assert.ok(!received[0].includes('lab.clixml'));
    assert.ok(received[0].includes('-Property total_memory_kb'));
    assert.equal(audits[0].sid,principal.sid);
    assert.equal(audits[0].outcome,'succeeded');
    assert.ok(!JSON.stringify(audits).includes('parameters'));
  } finally {await client.close();await server.close();}
});
