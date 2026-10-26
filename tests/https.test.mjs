import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { once } from 'node:events';
import { createHttpsService } from '../dist/https-server.js';
import { AccessError } from '../dist/auth.js';
import { config, manifest, principal } from './fixtures.mjs';

async function fixture(t, execute) {
  const directory=await mkdtemp(join(tmpdir(),'dbatools-tls-'));
  if(process.platform==='win32') execFileSync(process.env.PWSH_EXE??'pwsh',['-NonInteractive','-NoProfile','-File','scripts/new-test-certificate.ps1','-Directory',directory]);
  else execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
  const cert=await readFile(join(directory,'cert.pem'));
  const {server}=createHttpsService({...config,transport:'https'}, {host:'127.0.0.1',port:0,allowedHosts:['127.0.0.1'],allowedOrigins:['https://client.example'],tls:{cert,key:await readFile(join(directory,'key.pem'))}}, {
    validate:async(user,password)=>{
      if(password!=='synthetic-test-password')throw new AccessError(401,'Invalid login');
      return {...principal,roles:user==='HOST\\reader'?['reader']:['operator']};
    },
    dependencies:{manifest:()=>manifest,checkEnvironment:async()=>({ok:true,version:'2.9.1',identity:'HOST\\service'}),
      resolveCredentials:async(refs,p)=>{
        if(refs.SqlCredential==='forbidden')throw new AccessError(403,'Credential profile is not permitted');
        return Object.fromEntries(Object.keys(refs).map(n=>[n,'C:\\protected\\lab.clixml']));
      },execute:execute??(async()=>({stdout:'[{"Name":"fixture"}]',stderr:'',exitCode:0})),audit:()=>{}},
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
  const origin=`https://127.0.0.1:${server.address().port}`;
  function call(path, body, headers={}, trust=true) {
    return new Promise((resolve,reject)=>{
      const data=body===undefined?undefined:JSON.stringify(body);
      const req=request(origin+path,{method:'POST',servername:'localhost',ca:trust?cert:undefined,headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{}),...headers}},res=>{
        let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:text?JSON.parse(text):null}));
      });req.on('error',reject);req.end(data);
    });
  }
  const login=async(user='HOST\\operator')=>(await call('/auth/login',{username:user,password:'synthetic-test-password'})).body.token;
  const rpc=(token,method,params={})=>call('/mcp',{jsonrpc:'2.0',id:1,method,params},{Authorization:`Bearer ${token}`});
  return {call,login,rpc};
}

test('real HTTPS enforces TLS, host/origin checks, authentication, roles and logout', async t=>{
  const {call,login,rpc}=await fixture(t);
  await assert.rejects(call('/auth/login',{}, {},false),/self-signed|certificate/i);
  assert.equal((await call('/mcp',{})).status,401);
  assert.equal((await call('/auth/login',{username:'HOST\\reader',password:'wrong'})).status,401);
  assert.equal((await call('/auth/login',{username:'HOST\\reader',password:'wrong'},{Host:'attacker.example'})).status,403);
  assert.equal((await call('/auth/login',{}, {Origin:'https://attacker.example'})).status,403);
  const reader=await login('HOST\\reader');
  const initialized=await rpc(reader,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
  assert.equal(initialized.status,200);
  assert.equal((await rpc(reader,'tools/list')).body.result.tools.length,4);
  assert.equal((await rpc(reader,'resources/list')).body.result.resources.length,1);
  assert.equal((await rpc(reader,'tools/call',{name:'invoke_dbatools_command',arguments:{commandName:'Get-DbaDatabase'}})).status,403);
  assert.equal((await call('/auth/logout',undefined,{Authorization:`Bearer ${reader}`})).status,204);
  assert.equal((await rpc(reader,'tools/list')).status,401);
});

test('HTTPS operator invocation rejects inline secrets and unauthorized credential profiles',async t=>{
  let received;
  const {login,rpc}=await fixture(t,async(...args)=>{received=args;return {stdout:'[]',stderr:'',exitCode:0};});
  const token=await login();
  const invoke=arguments_=>rpc(token,'tools/call',{name:'invoke_dbatools_command',arguments:arguments_});
  const denied=await invoke({commandName:'Get-DbaDatabase',parameters:{SqlCredential:{username:'x',password:'fake'}}});
  assert.ok(denied.body.result.isError);
  assert.equal(received,undefined);
  const forbidden=await invoke({commandName:'Get-DbaDatabase',credentialRefs:{SqlCredential:'forbidden'}});
  assert.ok(forbidden.body.result.isError);
  const allowed=await invoke({commandName:'Get-DbaDatabase',credentialRefs:{SqlCredential:'lab'}});
  assert.ok(!allowed.body.result.isError);
  assert.equal(received[1].usePersistentSession,false);
  assert.equal(received[2].credentialFiles.SqlCredential,'C:\\protected\\lab.clixml');
});

test('one failed concurrent HTTPS execution does not fail another caller',async t=>{
  const {login,rpc}=await fixture(t,async(_script,_config,data)=>{
    await new Promise(r=>setTimeout(r,20));
    if(data.parameters.SqlInstance==='fail')throw new Error('Synthetic timeout');
    return {stdout:'[]',stderr:'',exitCode:0};
  });
  const token=await login();
  const results=await Promise.all(['fail','ok'].map(SqlInstance=>rpc(token,'tools/call',{name:'invoke_dbatools_command',arguments:{commandName:'Get-DbaDatabase',parameters:{SqlInstance}}})));
  assert.ok(results[0].body.result.isError);
  assert.ok(!results[1].body.result.isError);
});
