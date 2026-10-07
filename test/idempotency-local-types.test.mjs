import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareDeclaredData } from '../dist/lib/declared-data.js';
import { runTypecheck } from '../dist/lib/typecheck.js';
const sha256 = value => createHash('sha256').update(value).digest('hex');
// Fixed-schema output from the published 0.37.20 generator (543e47ea); no Git history is needed in CI.
const legacy = { runtime: '501b9a919262adcec45da0a0b96c321f3b8f31cebff33f4d14a73927141b3b25', manifest: 'c9cad492ee635ff6ccd77bc0a4405f5511d7ebeca8395b869274e48613d16025', digest: 'f94004dfa2945b48b99475ea839686f362682d04251cfcf24d7436a4310c6dc7' };
const schema = `export default schema({notes:table({id:id(),title:text()},{scope:owner(),client:{read:['id','title'],create:['title']}})});`;
test('local optional receipt handles do not advertise capable runtime or manifest', async t => {
 const root=mkdtempSync(join(tmpdir(),'cli-idem-types-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'db'));mkdirSync(join(root,'src'));
 writeFileSync(join(root,'db/schema.ts'),schema);
 writeFileSync(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,skipLibCheck:false,target:'ES2022',module:'ESNext',moduleResolution:'Bundler'},include:['src']}));
 writeFileSync(join(root,'src/main.ts'),`import {data,DataError} from 'somewhere:data';
const row=await data.notes.create({title:'Hello'});
const title:string|undefined=row.data?.title;
if(row.request){const key:string=row.request.key;const retried=await row.request.retry();const value:string|undefined=retried.data?.title;}
if(row.idempotency){const replayed:boolean=row.idempotency.replayed;}
const error=new DataError(503,{});if(error.request) await error.request.retry();
// @ts-expect-error Local tooling does not offer explicit key options.
data.notes.create({title:'Hi'},{idempotencyKey:'consumer-key-123456789'});
// @ts-expect-error Receipt support is optional, never attested locally.
const required:boolean=row.idempotency.replayed;
`);
 const prepared=prepareDeclaredData(root);
 assert.equal(sha256(prepared.client.runtime),legacy.runtime);
 assert.equal(sha256(JSON.stringify(prepared.client.manifest)),legacy.manifest);
 assert.equal(prepared.client.contract_digest,legacy.digest);
 assert.equal(prepared.client.manifest.insert_receipt,undefined);
 assert.match(readFileSync(prepared.declarationPath,'utf8'),/readonly request\?:/);
 const checked=await runTypecheck(root,{installTypePackages:false});assert.equal(checked.ok,true,checked.raw);
});
