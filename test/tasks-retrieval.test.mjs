import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Command } from 'commander';

// Execute the source command registration; replace only transport. No credentials or network.
const src = new URL('../src/', import.meta.url).href;
const calls=[];
globalThis.__tasksCall = async (name,args) => { calls.push({name,args}); return globalThis.__tasksResponse; };
const hooks=registerHooks({
  resolve(specifier,context,next) {
    if (specifier.startsWith(src)) return {url:specifier,shortCircuit:true};
    if (context.parentURL?.startsWith(src) && specifier.startsWith('.') && specifier.endsWith('.js')) return {url:new URL(specifier,context.parentURL).href,shortCircuit:true};
    return next(specifier,context);
  },
  load(url,context,next) {
    if (url===src+'lib/platform-tools.js') return {format:'module',source:'export const callPlatformTool=(...args)=>globalThis.__tasksCall(...args);',shortCircuit:true};
    const sourcePath=url.startsWith(src) && url.endsWith('.js') ? fileURLToPath(url).replace(/\.js$/,'.ts') : null;
    if (sourcePath && existsSync(sourcePath)) return {format:'module',source:ts.transpileModule(readFileSync(sourcePath,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};
    return next(url,context);
  },
});
const { registerTasks }=await import(src+'commands/tasks.js');
async function run(args,response) {
  globalThis.__tasksResponse=response;
  const lines=[], old=console.log; console.log=(...parts)=>lines.push(parts.join(' '));
  try { const program=new Command(); registerTasks(program); await program.parseAsync(['node','sw',...args]); }
  finally { console.log=old; }
  return lines.join('\n');
}
test('task commands preserve explicit pagination and every retrieval option',async()=>{
  const output=await run(['tasks','list','--project','project','--query','vision','--cursor','opaque','--limit','3'],
    {ok:true,data:[{id:'tsk_1',title:'One',status:'open',priority:'high',updated_at:1,omitted:{description:{json_chars:9000}}}],page:{total:30,count:1,has_more:true,next_cursor:'next',order:'created_at DESC, id DESC',consistency:'ordered membership'}});
  assert.deepEqual(calls.at(-1),{name:'tasks_list',args:{project_id:'project',q:'vision',limit:3,cursor:'opaque'}});
  assert.match(output,/Showing 1 of 30/); assert.match(output,/--cursor 'next'/); assert.match(output,/Some fields are partial/);
  assert.match(output,/created_at DESC, id DESC/);
  await run(['tasks','get','tsk_1','--project','project','--view','history','--kind','activity','--cursor','history-next','--limit','5'],{ok:true,data:{page:{next_cursor:'later'}}});
  assert.deepEqual(calls.at(-1),{name:'tasks_get',args:{project_id:'project',task_id:'tsk_1',view:'history',kind:'activity',cursor:'history-next',limit:5}});
  await run(['tasks','get','tsk_1','--project','project','--view','field','--kind','comments','--event-id','tcm_1','--field','body','--cursor','field-next'],{ok:true,data:{content:'chunk'}});
  assert.deepEqual(calls.at(-1),{name:'tasks_get',args:{project_id:'project',task_id:'tsk_1',view:'field',kind:'comments',field:'body',event_id:'tcm_1',cursor:'field-next'}});
  const json=await run(['tasks','list','--project','project','--json'],{ok:true,data:[],page:{next_cursor:'visible'}});
  assert.equal(JSON.parse(json).page.next_cursor,'visible');
  await run(['tasks','get','tsk_1','--project','project','--view','full'],{ok:true,data:{comments:['all']}});
  assert.equal(calls.at(-1).args.view,'full');
  assert.equal(calls.length,5,'one tool call per command; no automatic page draining');
});
test.after(()=>{hooks.deregister();delete globalThis.__tasksCall;delete globalThis.__tasksResponse;});
