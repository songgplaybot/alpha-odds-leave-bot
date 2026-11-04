import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import pg from 'pg';
import {createJob,pending} from '../src/db.js';

await mkdir(new URL('../.wrangler/',import.meta.url),{recursive:true});
await build({entryPoints:[new URL('../src/worker.js',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.html':'text'},outfile:new URL('../.wrangler/test-worker.mjs',import.meta.url).pathname});
const {default:worker,processApproval,TelegramError}=await import('../.wrangler/test-worker.mjs');
test('HTTP endpoints reject unsigned admin and webhook requests before reaching the database',async()=>{
 const env={BOT_TOKEN:'test-token',ADMIN_ID:123};
 assert.equal((await worker.fetch(new Request('https://bot.test/',{method:'HEAD'}),env)).status,200);
 assert.equal((await worker.fetch(new Request('https://bot.test/api/admin/all',{method:'POST'}),env)).status,403);
 assert.equal((await worker.fetch(new Request('https://bot.test/telegram-webhook',{method:'POST',body:'{}'}),env)).status,403);
 assert.equal((await worker.fetch(new Request('https://bot.test/admin'),env)).status,200);
});
test('1000 approvals survive duplicate delivery, rate limits, and a failed storage transaction',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const db=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await db.connect();
 try{
  // These connection-local temporary tables shadow production. No real users are touched.
  for(const name of ['users','join_requests','cf_approval_jobs','cf_updates'])await db.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
  await db.query(`INSERT INTO join_requests(user_id,first_name,status,requested_at) SELECT n,'Fixture','pending','2026-11-04 00:00:00' FROM generate_series(1,1000) n`);
  const {job}=await createJob(db,await pending(db),null);
  const sent=[];const env={BOT_TOKEN:'test',CHANNEL_ID:-100,APPROVAL_QUEUE:{send:async(data,opts)=>sent.push([data,opts])}};
  let apiCalls=0,first=true,max=0,active=0;
  const api=async(_,body)=>{apiCalls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,1));active--;if(first&&body.user_id===1)throw new TelegramError({error_code:429,parameters:{retry_after:10}});return true;};
  await processApproval(db,env,job.id,api);first=false;
  let saved=(await db.query('SELECT * FROM cf_approval_jobs WHERE id=$1',[job.id])).rows[0];
  assert.equal(saved.counts.approved,31);assert.equal(saved.pending_ids.length,969);assert.equal(sent[0][1].delaySeconds,11);
  const before=apiCalls;assert.ok((await processApproval(db,env,job.id,api)).retry);assert.equal(apiCalls,before);
  await db.query('UPDATE cf_approval_jobs SET not_before=now() WHERE id=$1',[job.id]);
  await db.query("UPDATE cf_approval_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1",[job.id]);
  assert.ok((await processApproval(db,env,job.id,api)).retry);assert.equal(apiCalls,before);
  await db.query('UPDATE cf_approval_jobs SET lease_until=NULL WHERE id=$1',[job.id]);
  let iterations=0;
  while((await db.query('SELECT status FROM cf_approval_jobs WHERE id=$1',[job.id])).rows[0].status==='running'){
   assert.ok(++iterations<60);await processApproval(db,env,job.id,api);
  }
  saved=(await db.query('SELECT * FROM cf_approval_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(saved.counts.approved,1000);assert.equal(saved.pending_ids.length,0);assert.equal((await pending(db)).length,0);assert.equal(max,32);
  const doneCalls=apiCalls;assert.ok((await processApproval(db,env,job.id,api)).done);assert.equal(apiCalls,doneCalls);
  await db.query("INSERT INTO join_requests(user_id,status,requested_at) VALUES(1001,'pending','2026-11-04 00:00:00')");
  const next=(await createJob(db,await pending(db),null)).job;
  const broken={query:(sql,args)=>{if(sql.startsWith('UPDATE join_requests jr'))throw Error('simulated storage interruption');return db.query(sql,args);}};
  await assert.rejects(processApproval(broken,env,next.id,api));
  assert.equal((await pending(db)).length,1);assert.equal((await db.query('SELECT counts FROM cf_approval_jobs WHERE id=$1',[next.id])).rows[0].counts.approved,0);
  await processApproval(db,env,next.id,async()=>{throw new TelegramError({error_code:400,description:'USER_ALREADY_PARTICIPANT'});});
  assert.equal((await pending(db)).length,0);
 }finally{await db.end();}
});
