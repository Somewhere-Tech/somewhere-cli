import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readdirSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';

test('durable Advisor CLI persists identity before POST, resumes lost acknowledgment and never starts a substitute run',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'advisor-runs-'));process.env.SOMEWHERE_CONFIG_DIR=dir;
  const records=new Map(),requests=[];let loseAck=true,billed=0,completed=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):null;requests.push({path:req.url,method:req.method,body,capability:req.headers['x-advisor-capability'],auth:req.headers.authorization});
    const files=readdirSync(join(dir,'advisor-runs'));assert.ok(files.some(file=>file.endsWith('.json')),'Identity exists before network dispatch');
    res.setHeader('Content-Type','application/json');
    if(req.url==='/advisor/runs'){
      if(!records.has(body.request_id)){billed++;records.set(body.request_id,{run_id:'00000000-0000-4000-8000-000000000001',status:'in_progress',next_step:'status'});}
      if(loseAck){loseAck=false;req.socket.destroy();return;}
      res.end(JSON.stringify({ok:true,data:records.get(body.request_id)}));
    }else if(req.url.endsWith('/cancel'))res.end(JSON.stringify({ok:true,data:{run_id:'00000000-0000-4000-8000-000000000001',status:'in_progress',cancel_requested:true}}));
    else res.end(JSON.stringify({ok:true,data:{run_id:'00000000-0000-4000-8000-000000000001',status:completed?'settled':'in_progress',next_step:'status',...(completed?{answer:'Captured same response.',incomplete:false}:{})}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));process.env.SOMEWHERE_MCP_URL=`http://127.0.0.1:${server.address().port}/mcp`;
  const {callAdvisorRun}=await import('../dist/lib/advisor-runs.js');
  try{
    let failed;try{await callAdvisorRun({question:'Explain the original question.',wait:false});}catch(error){failed=error;}
    assert.match(failed.message,/Resume only this request/);assert.equal(requests.length,1,'No automatic POST retry');
    const file=readdirSync(join(dir,'advisor-runs')).find(file=>file.endsWith('.json')),id=file.slice(0,-5);
    const stored=JSON.parse(readFileSync(join(dir,'advisor-runs',file),'utf8'));assert.equal(stored.request_id,requests[0].body.request_id);assert.equal(statSync(join(dir,'advisor-runs',file)).mode&0o777,0o600);
    await assert.rejects(callAdvisorRun({requestId:id,operation:'cancel',wait:false}),/no cancellation or replacement dispatch/);assert.equal(requests.length,1);
    const recovered=await callAdvisorRun({requestId:id,operation:'resume',wait:false});assert.equal(recovered.run_id,'00000000-0000-4000-8000-000000000001');assert.equal(billed,1);assert.deepEqual(requests[0].body,requests[1].body);assert.equal(requests[0].capability,requests[1].capability);
    for(let i=0;i<31;i++){const status=await callAdvisorRun({requestId:id,operation:'status',wait:false});assert.equal(status.status,'in_progress');}
    assert.equal(billed,1);assert.equal(requests.filter(r=>r.path==='/advisor/runs').length,2);
    await callAdvisorRun({requestId:id,operation:'cancel',wait:false});assert.equal(billed,1);
    const {saveConfig,clearConfig}=await import('../dist/lib/config.js');saveConfig({token:'smt_new_fixture',user:{email:'fixture@example.invalid'}});
    await callAdvisorRun({requestId:id,operation:'status',wait:false});assert.equal(requests.at(-1).auth,undefined,'Signing in does not change anonymous run ownership');clearConfig();
    completed=true;const final=await callAdvisorRun({requestId:id,operation:'status',wait:false});assert.equal(final.answer,'Captured same response.');assert.equal(JSON.parse(readFileSync(join(dir,'advisor-runs',file),'utf8')).body,undefined,'Terminal local receipt drops retained question/context');
    const command=spawn(process.execPath,['--input-type=module','-e',"import {Command} from 'commander';import {registerAdvisor} from './dist/commands/advisor.js';const program=new Command();registerAdvisor(program);await program.parseAsync(['node','somewhere','advisor','Explain a generic contract','--async','--json','--no-context']);"],{cwd:new URL('..',import.meta.url),env:{...process.env},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';command.stdout.on('data',data=>{stdout+=data;});command.stderr.on('data',data=>{stderr+=data;});const code=await new Promise(resolve=>command.on('close',resolve));assert.equal(code,0,stderr);assert.equal(JSON.parse(stdout).answer,'Captured same response.');assert.match(stderr,/To reconnect/);assert.ok(requests.every(r=>!r.path.startsWith('/health')));
    saveConfig({token:'smt_account_fixture',user:{email:'fixture@example.invalid'}});const account=await callAdvisorRun({question:'Account question',wait:false});assert.equal(requests.at(-1).auth,'Bearer smt_account_fixture');const accountRecord=readFileSync(join(dir,'advisor-runs',account.request_id+'.json'),'utf8');assert.equal(accountRecord.includes('smt_account_fixture'),false,'Run receipt never duplicates bearer');clearConfig();const count=requests.length;await assert.rejects(callAdvisorRun({requestId:account.request_id,operation:'status',wait:false}),/Sign in to the account/);assert.equal(requests.length,count,'Account run cannot downgrade to anonymous after logout');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
