import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';

test('durable Advisor expiry erases local payloads without replaying an unknown admission or stranding cancellation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'advisor-retention-'));process.env.SOMEWHERE_CONFIG_DIR=dir;
  const requests=[];let terminal=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):null;requests.push({path:req.url,body,capability:req.headers['x-advisor-capability']});
    res.setHeader('Content-Type','application/json');
    if(req.url==='/advisor/runs')res.end(JSON.stringify({ok:true,data:{run_id:'00000000-0000-4000-8000-000000000002',status:'in_progress',provider_status:'in_progress',payload_expires_at:Date.now()+86400000}}));
    else res.end(JSON.stringify({ok:true,data:{run_id:'00000000-0000-4000-8000-000000000002',status:terminal?'settled':'in_progress',provider_status:terminal?'completed':'in_progress',answer:'PRIVATE LATE CONTENT',partial_output:'PRIVATE PARTIAL',payload_expires_at:Date.now()+86400000}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));process.env.SOMEWHERE_MCP_URL=`http://127.0.0.1:${server.address().port}/mcp`;
  const {callAdvisorRun}=await import('../dist/lib/advisor-runs.js');
  const file=id=>join(dir,'advisor-runs',id+'.json');
  const load=id=>JSON.parse(readFileSync(file(id),'utf8'));
  const age=id=>{const saved=load(id);saved.request_created_at=Date.now()-86400001;writeFileSync(file(id),JSON.stringify(saved));return saved;};
  try{
    const run=await callAdvisorRun({question:'Private pending question',wait:false});
    const admitted=load(run.request_id),deadline=admitted.payload_expires_at;
    assert.equal(admitted.body,undefined);
    await callAdvisorRun({requestId:run.request_id,operation:'status',wait:false});
    assert.equal(load(run.request_id).payload_expires_at,deadline,'A later response cannot renew the fixed deadline');
    age(run.request_id);
    const cancelled=await callAdvisorRun({requestId:run.request_id,operation:'cancel',wait:false});
    assert.ok(requests.at(-1).path.endsWith('/cancel'));
    assert.equal(requests.at(-1).capability,admitted.capability,'Unresolved paid work retains its cancellation handle');
    assert.equal(cancelled.payload_expired,true);assert.equal(cancelled.answer,undefined);assert.equal(cancelled.partial_output,undefined);
    assert.equal(load(run.request_id).capability,admitted.capability);
    terminal=true;
    await callAdvisorRun({requestId:run.request_id,operation:'status',wait:false});
    const settled=load(run.request_id);assert.equal(settled.capability,undefined);assert.equal(settled.body,undefined);assert.equal(settled.terminal,undefined);
    const count=requests.length;
    const expired=await callAdvisorRun({requestId:run.request_id,operation:'status',wait:false});
    assert.equal(expired.payload_expired,true);assert.equal(requests.length,count,'Settled expired handle does not fetch or redispatch');
    const unknown='00000000-0000-4000-8000-000000000003';
    writeFileSync(file(unknown),JSON.stringify({owner_mode:'anonymous',request_id:unknown,request_created_at:Date.now()-86400001,capability:'PRIVATE CAP',body:{question:'PRIVATE QUESTION',context:{last_run:'PRIVATE'},request_id:unknown,request_created_at:Date.now()-86400001}}));
    await assert.rejects(callAdvisorRun({requestId:unknown,operation:'resume',wait:false}),/admission outcome remains unknown; no retry or replacement/);
    assert.equal(requests.length,count,'Expired unknown admission never replays POST');
    assert.equal(load(unknown).body,undefined);assert.equal(load(unknown).capability,undefined);
    assert.equal(readFileSync(file(unknown),'utf8').includes('PRIVATE'),false);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
