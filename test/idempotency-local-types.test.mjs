import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareDeclaredData } from '../dist/lib/declared-data.js';
import { runTypecheck } from '../dist/lib/typecheck.js';
const require = createRequire(import.meta.url);
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
 writeFileSync(join(root,'legacy.cjs'),execFileSync('git',['show','543e47eaeb5ac9c16bb3ac75927eedd8675febeb:runtime/declared-data.cjs'],{cwd:new URL('..',import.meta.url),maxBuffer:16*1024*1024}));
 const old=require(join(root,'legacy.cjs'));
 const prepared=prepareDeclaredData(root);const legacy=old.generateFromFiles({'db/schema.ts':schema});
 assert.equal(prepared.client.runtime,legacy.runtime);
 assert.equal(JSON.stringify(prepared.client.manifest),JSON.stringify(legacy.manifest));
 assert.equal(prepared.client.contract_digest,legacy.contract_digest);
 assert.equal(prepared.client.manifest.insert_receipt,undefined);
 assert.match(readFileSync(prepared.declarationPath,'utf8'),/readonly request\?:/);
 const checked=await runTypecheck(root,{installTypePackages:false});assert.equal(checked.ok,true,checked.raw);
});
