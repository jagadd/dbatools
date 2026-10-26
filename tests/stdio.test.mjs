import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { manifest } from './fixtures.mjs';

test('actual default STDIO entrypoint preserves four tools and help resources', async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dbatools-stdio-'));
  const file=join(directory,'help.json');await writeFile(file,JSON.stringify(manifest));
  const transport=new StdioClientTransport({command:process.execPath,args:['dist/server.js'],env:{...process.env,DBATOOLS_TRANSPORT:'stdio',DBATOOLS_HELP_INDEX:file,PWSH_EXE:'intentionally-unavailable-pwsh'},stderr:'pipe'});
  transport.stderr?.on('data', chunk => process.stderr.write(chunk));
  const client=new Client({name:'stdio-fixture',version:'1'});
  t.after(async()=>{await client.close();await rm(directory,{recursive:true,force:true});});
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length,4);
  assert.equal((await client.listResources()).resources[0].uri,'dbatools://command/Get-DbaDatabase');
  assert.ok((await client.callTool({name:'get_dbatools_command_help',arguments:{commandName:'Get-DbaDatabase'}})).content[0].text.includes('List databases'));
});
