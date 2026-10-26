export const help = { name:'Get-DbaDatabase', verb:'Get', noun:'DbaDatabase', synopsis:'List databases', description:'Fixture help', riskLevel:'readonly', tags:[], examples:[], relatedLinks:[], parameters:[
  {name:'SqlInstance',type:'DbaInstance[]',required:false,aliases:[],pipelineInput:false,description:'Instance'},
  {name:'SqlCredential',type:'PSCredential',required:false,aliases:['LoginCredential'],pipelineInput:false,description:'Credential'},
  {name:'Credential',type:'System.Management.Automation.PSCredential',required:false,aliases:[],pipelineInput:false,description:'Host credential'},
  {name:'SecurePassword',type:'SecureString',required:false,aliases:[],pipelineInput:false,description:'Secret'},
] };
export const manifest = { generatedAt:'2026-10-26', dbatoolsVersion:'2.9.1', commandCount:1, commands:{[help.name]:help} };
export const config = {transport:'stdio',powershellExe:'pwsh',safeMode:true,maxOutputRows:100,commandTimeout:60,usePersistentSession:true};
export const principal = {kind:'windows',sid:'S-1-5-21-123-456-789-1001',roles:['operator']};

