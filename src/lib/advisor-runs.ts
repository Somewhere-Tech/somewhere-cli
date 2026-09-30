import {randomBytes,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {cliConfigDir,loadConfig} from './config.js';
import {fetchWithProxy} from './http.js';
import {redactAdvisorText,type AdvisorContext} from './advisor-context.js';
interface LocalRun {owner_mode:'account'|'anonymous';terminal?:AdvisorRunResult;request_id:string;request_created_at:number;capability:string;run_id?:string;body?:{question:string;context?:AdvisorContext;request_id:string;request_created_at:number}}
export interface AdvisorRunResult {run_id?:string;status:string;answer?:string;error?:string;incomplete?:boolean;next_step?:string;retry_after_seconds?:number;request_id?:string}
const directory=()=>join(cliConfigDir(),'advisor-runs');
function path(id:string):string {if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('Invalid Advisor request ID.');return join(directory(),id+'.json');}
function save(record:LocalRun):void {mkdirSync(directory(),{recursive:true,mode:0o700});chmodSync(directory(),0o700);const target=path(record.request_id),temporary=target+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'});renameSync(temporary,target);chmodSync(target,0o600);}
function load(id:string):LocalRun {if(!existsSync(path(id)))throw Error('Advisor request was not found in this CLI configuration.');return JSON.parse(readFileSync(path(id),'utf8')) as LocalRun;}
function url(suffix:string):string {const result=new URL(process.env.SOMEWHERE_MCP_URL||'https://mcp.somewhere.tech/mcp');result.pathname='/advisor/runs'+suffix;result.search='';result.hash='';return result.toString();}
async function request(record:LocalRun,operation:'start'|'status'|'resume'|'cancel'):Promise<AdvisorRunResult>{
  const config=loadConfig(),token=record.owner_mode==='account'&&config?.temporary!==true?config?.token:undefined;
  if(record.owner_mode==='account'&&!token)throw Error('Sign in to the account that owns this saved request.');
  const res=await fetchWithProxy(url(operation==='start'?'':'/'+record.run_id+(operation==='status'?'':'/'+operation)),{method:operation==='status'?'GET':'POST',headers:{'Content-Type':'application/json','User-Agent':'somewhere-cli',...(token?{Authorization:'Bearer '+token}:{'X-Advisor-Capability':record.capability})},...(operation==='start'?{body:JSON.stringify(record.body)}:{})},30000);
  const payload=await res.json() as {ok?:boolean;data?:AdvisorRunResult;error?:string;message?:string};
  if(!res.ok||!payload.ok||!payload.data)throw Error((payload.message||payload.error||'Advisor transport failed.')+' [HTTP '+res.status+']');
  if(payload.data.run_id)record.run_id=payload.data.run_id;if(payload.data.status==='settled'||payload.data.answer){delete record.body;if(!record.run_id)record.terminal=payload.data;}save(record);return {...payload.data,request_id:record.request_id};
}
/** Local identity is written before POST. Transport failure never creates another request. */
export async function callAdvisorRun(args:{question?:string;context?:AdvisorContext;requestId?:string;operation?:'status'|'resume'|'cancel';wait?:boolean;progress?:(message:string)=>void}):Promise<AdvisorRunResult>{
  let record:LocalRun;
  if(args.requestId)record=load(args.requestId);
  else{if(!args.question)throw Error('Supply a question or --resume <request-id>.');const id=randomUUID(),created=Date.now(),context=args.context?{...args.context}:undefined;if(context?.file)delete context.file;const config=loadConfig();record={owner_mode:config?.token&&config.temporary!==true?'account':'anonymous',request_id:id,request_created_at:created,capability:randomBytes(32).toString('hex'),body:{question:redactAdvisorText(args.question),...(context?{context}:{}),request_id:id,request_created_at:created}};save(record);}
  try{
    if(record.terminal)return {...record.terminal,request_id:record.request_id};
    if(args.operation==='cancel'&&!record.run_id)throw Error('Start acknowledgment is unavailable; no cancellation or replacement dispatch was attempted. Recover only this original request.');
    let result=await request(record,record.run_id?(args.operation??'resume'):'start');
    if(args.wait===false||args.operation==='status'||args.operation==='cancel')return result;
    args.progress?.('Advisor is working. To reconnect: somewhere advisor --resume '+record.request_id);
    while(result.status!=='settled'&&!result.answer){await new Promise(resolve=>setTimeout(resolve,Math.min(10000,Math.max(1000,(result.retry_after_seconds??2)*1000))));result=await request(record,result.next_step==='resume'?'resume':'status');}
    return result;
  }catch(error){throw Error((error instanceof Error?error.message:String(error))+' Resume only this request: somewhere advisor --resume '+record.request_id);}
}
