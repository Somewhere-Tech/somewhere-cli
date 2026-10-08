import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareDeclaredData } from '../dist/lib/declared-data.js';
import { runTypecheck } from '../dist/lib/typecheck.js';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const ordinary = `export default schema({notes:table({id:id(),title:text()},{scope:owner(),client:{read:['id','title'],create:['title']}})});`;
const schema = `export default schema({
 notes: table({id:id(),title:text()},{scope:owner(),client:{read:['id','title'],create:['title'],links:{read:true,anonymousCreate:true}}}),
 consultants: table({id:id(),slug:text({unique:true}),name:text(),published:boolean({default:false}),accepting:boolean({default:false})},
  {scope:owner(),client:{read:['id','slug','name'],publicRead:{where:{published:true}}}}),
 requests: table({id:id(),message:text(),reply_email:text(),status:text({default:'new'})},
  {scope:owner(),client:{intake:{target:{table:'consultants',field:'slug'},fields:['message','reply_email'],where:{accepting:true}}}}),
});`;
test('canonical creator and intake local types preserve ordinary output', async t => {
 const root=mkdtempSync(join(tmpdir(),'cli-creator-intake-types-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'db'));mkdirSync(join(root,'src'));
 writeFileSync(join(root,'db/schema.ts'),ordinary);
 const baseline=prepareDeclaredData(root).client;
 assert.equal(sha256(baseline.runtime),'501b9a919262adcec45da0a0b96c321f3b8f31cebff33f4d14a73927141b3b25');
 assert.equal(sha256(JSON.stringify(baseline.manifest)),'c9cad492ee635ff6ccd77bc0a4405f5511d7ebeca8395b869274e48613d16025');
 assert.equal(baseline.contract_digest,'f94004dfa2945b48b99475ea839686f362682d04251cfcf24d7436a4310c6dc7');
 writeFileSync(join(root,'db/schema.ts'),schema);
 writeFileSync(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,skipLibCheck:false,target:'ES2022',module:'ESNext',moduleResolution:'Bundler'},include:['src']}));
 writeFileSync(join(root,'src/main.ts'),`import {data,type CreatorCapability} from 'somewhere:data';
import {table,id,text,owner} from 'somewhere/db';
table({id:id(),message:text()},{scope:owner(),client:{intake:{target:{table:'consultants',field:'slug'},
// @ts-expect-error intake.fields must name declared destination columns
fields:['missing_destination_column']}}});
const created=await data.notes.createAnonymous({title:'Plan'});
const capability:CreatorCapability=created.creator;
const url:string=capability.url;
const title:string|undefined=created.data?.title;
await created.request.retry();
const view=data.creator(created.grant);
const claimed=await view.notes.claim(1,{keepShares:true});
const shares:'kept'|'revoked'|'unknown'=claimed.shares;
const status:'claimed_by_you'|'not_claimed'|'unknown'=(await view.notes.claimStatus(1)).status;
const submitted=await data.requests.intake('ada',{message:'Hello',reply_email:'a@example.test'});
const accepted:true=submitted.accepted;
const replayed:boolean=submitted.idempotency.replayed;
await submitted.request.retry();
// @ts-expect-error owner is supplied by the platform
await data.notes.createAnonymous({title:'Plan',user_id:'mallory'});
// @ts-expect-error creator claim accepts no owner override
await view.notes.claim(1,{owner:'mallory'});
// @ts-expect-error intake accepts no owner field
await data.requests.intake('ada',{message:'Hello',reply_email:'a@example.test',user_id:'mallory'});
// @ts-expect-error private status is not an intake field
await data.requests.intake('ada',{message:'Hello',reply_email:'a@example.test',status:'done'});
// @ts-expect-error reference has the exact declared string type
await data.requests.intake(1,{message:'Hello',reply_email:'a@example.test'});
// @ts-expect-error intake is acknowledgement only
submitted.data;
// @ts-expect-error intake exists only on the declared destination
await data.notes.intake('ada',{title:'Hello'});
`);
 const prepared=prepareDeclaredData(root);
 const declaration=readFileSync(prepared.declarationPath,'utf8');
 assert.match(declaration,/createAnonymous/);assert.match(declaration,/intake\(reference: string/);assert.match(declaration,/claimStatus/);
 // Local declarations do not attest a receipt-capable runtime.
 assert.equal(prepared.client.manifest.insert_receipt,undefined);
 assert(!prepared.client.runtime.includes('create_anonymous'));assert(!prepared.client.runtime.includes('operation:\'intake\''));
 const checked=await runTypecheck(root,{installTypePackages:false});assert.equal(checked.ok,true,checked.raw);
});
