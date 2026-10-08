import {randomBytes,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {cliConfigDir,loadConfig} from './config.js';
import {fetchWithProxy} from './http.js';
import {redactAdvisorText,type AdvisorContext} from './advisor-context.js';
interface LocalRun {owner_mode:'account'|'anonymous';terminal?:AdvisorRunResult;request_id:string;request_created_at:number;capability?:string;payload_expires_at?:number;provider_settled?:boolean;run_id?:string;body?:{question:string;context?:AdvisorContext;request_id:string;request_created_at:number}}
export interface AdvisorRunResult {run_id?:string;status:string;answer?:string;error?:string;incomplete?:boolean;next_step?:string;retry_after_seconds?:number;request_id?:string;provider_status?:string;payload_expires_at?:number;payload_expired?:boolean;partial_output?:string}
const directory=()=>join(cliConfigDir(),'advisor-runs');
function path(id:string):string {if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('Invalid Advisor request ID.');return join(directory(),id+'.json');}
function save(record:LocalRun):void {mkdirSync(directory(),{recursive:true,mode:0o700});chmodSync(directory(),0o700);const target=path(record.request_id),temporary=target+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'});renameSync(temporary,target);chmodSync(target,0o600);}
const PAYLOAD_RETENTION_MS=24*60*60*1000;
function payloadDeadline(record:LocalRun):number {return Math.min(record.request_created_at+PAYLOAD_RETENTION_MS,record.payload_expires_at??Infinity);}
function payloadExpired(record:LocalRun):boolean {return payloadDeadline(record)<=Date.now();}
/** Local cleanup runs when a saved request is opened; status reads never renew its deadline. */
function prune(record:LocalRun):void {
  if(record.run_id)delete record.body;
  if(!payloadExpired(record))return;
  delete record.body;delete record.terminal;
  if(!record.run_id||record.provider_settled)delete record.capability;
}
function expiredResult(record:LocalRun):AdvisorRunResult {return {run_id:record.run_id,request_id:record.request_id,status:record.provider_settled?'settled':'delivery_expired',payload_expired:true,payload_expires_at:payloadDeadline(record),error:'ADVISOR_PAYLOAD_EXPIRED',incomplete:true,next_step:record.provider_settled?'none':'status'};}
function load(id:string):LocalRun {if(!existsSync(path(id)))throw Error('Advisor request was not found in this CLI configuration.');const record=JSON.parse(readFileSync(path(id),'utf8')) as LocalRun;prune(record);save(record);return record;}
function url(suffix:string):string {const result=new URL(process.env.SOMEWHERE_MCP_URL||'https://mcp.somewhere.tech/mcp');result.pathname='/advisor/runs'+suffix;result.search='';result.hash='';return result.toString();}
async function request(record:LocalRun,operation:'start'|'status'|'resume'|'cancel'):Promise<AdvisorRunResult>{
  const config=loadConfig(),token=record.owner_mode==='account'&&config?.temporary!==true?config?.token:undefined;
  if(record.owner_mode==='account'&&!token)throw Error('Sign in to the account that owns this saved request.');
  if(record.owner_mode==='anonymous'&&!record.capability)throw Error('This Advisor request has expired; no replacement request was sent.');
  const res=await fetchWithProxy(url(operation==='start'?'':'/'+record.run_id+(operation==='status'?'':'/'+operation)),{method:operation==='status'?'GET':'POST',headers:{'Content-Type':'application/json','User-Agent':'somewhere-cli',...(token?{Authorization:'Bearer '+token}:{'X-Advisor-Capability':record.capability})},...(operation==='start'?{body:JSON.stringify(record.body)}:{})},30000);
  const payload=await res.json() as {ok?:boolean;data?:AdvisorRunResult;error?:string;message?:string};
  if(!res.ok||!payload.ok||!payload.data)throw Error((payload.message||payload.error||'Advisor transport failed.')+' [HTTP '+res.status+']');
  if(payload.data.run_id)record.run_id=payload.data.run_id;
  if(Number.isSafeInteger(payload.data.payload_expires_at))record.payload_expires_at=Math.min(payloadDeadline(record),payload.data.payload_expires_at!);
  if(payload.data.payload_expired)record.payload_expires_at=Math.min(payloadDeadline(record),Date.now());
  if((payload.data.status==='settled'||(payload.data.payload_expired&&payload.data.next_step==='none'))&&payload.data.provider_status&&['completed','failed','incomplete','cancelled'].includes(payload.data.provider_status))record.provider_settled=true;
  if(payload.data.status==='settled'||payload.data.answer){delete record.body;if(!record.run_id){record.terminal=payload.data;record.provider_settled=true;}}
  prune(record);save(record);
  if(payloadExpired(record)||payload.data.payload_expired)return {...expiredResult(record),provider_status:payload.data.provider_status};
  return {...payload.data,request_id:record.request_id};
}
/** Local identity is written before POST. Transport failure never creates another request. */
export async function callAdvisorRun(args:{question?:string;context?:AdvisorContext;requestId?:string;operation?:'status'|'resume'|'cancel';wait?:boolean;progress?:(message:string)=>void}):Promise<AdvisorRunResult>{
  let record:LocalRun;
  if(args.requestId)record=load(args.requestId);
  else{if(!args.question)throw Error('Supply a question or --resume <request-id>.');const id=randomUUID(),created=Date.now(),context=args.context?{...args.context}:undefined;if(context?.file)delete context.file;const config=loadConfig();record={owner_mode:config?.token&&config.temporary!==true?'account':'anonymous',request_id:id,request_created_at:created,capability:randomBytes(32).toString('hex'),body:{question:redactAdvisorText(args.question),...(context?{context}:{}),request_id:id,request_created_at:created}};save(record);}
  try{
    if(payloadExpired(record)){if(!record.run_id)throw Error('The saved request payload expired and was removed. Its admission outcome remains unknown; no retry or replacement was sent.');if(record.provider_settled)return expiredResult(record);}
    if(record.terminal)return {...record.terminal,request_id:record.request_id};
    if(args.operation==='cancel'&&!record.run_id)throw Error('Start acknowledgment is unavailable; no cancellation or replacement dispatch was attempted. Recover only this original request.');
    let result=await request(record,record.run_id?(args.operation??'resume'):'start');
    if(result.payload_expired||args.wait===false||args.operation==='status'||args.operation==='cancel')return result;
    if(result.status!=='settled'&&!result.answer)args.progress?.('Advisor is working. To reconnect: somewhere advisor --resume '+record.request_id);
    while(result.status!=='settled'&&!result.answer&&!result.payload_expired){await new Promise(resolve=>setTimeout(resolve,Math.min(10000,Math.max(1000,(result.retry_after_seconds??2)*1000))));result=await request(record,result.next_step==='resume'?'resume':'status');}
    return result;
  }catch(error){throw Error((error instanceof Error?error.message:String(error))+(payloadExpired(record)&&!record.run_id?'':' Resume only this request: somewhere advisor --resume '+record.request_id));}
}

/** Adopt an unpaid legacy/native prepared handle before its first billable resume. */
export async function consumeAdvisorRun(text:string,progress?:(message:string)=>void):Promise<AdvisorRunResult|null>{
  let parsed:Record<string,unknown>;try{parsed=JSON.parse(text) as Record<string,unknown>;}catch{return null;}
  if(typeof parsed.run_id!=='string'||typeof parsed.status!=='string')return null;
  const config=loadConfig(),anonymous=typeof parsed.anonymous_capability==='string',id=randomUUID();
  if(!anonymous&&(!config?.token||config.temporary===true))throw Error('Sign in to the account that owns this Advisor run.');
  const record:LocalRun={owner_mode:anonymous?'anonymous':'account',request_id:id,request_created_at:Date.now(),capability:anonymous?String(parsed.anonymous_capability):randomBytes(32).toString('hex'),run_id:parsed.run_id,...(Number.isSafeInteger(parsed.payload_expires_at)?{payload_expires_at:Number(parsed.payload_expires_at)}:{})};save(record);
  return callAdvisorRun({requestId:id,operation:'resume',progress});
}
