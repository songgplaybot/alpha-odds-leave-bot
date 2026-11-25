import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import pg from 'pg';
import {createJob,pending} from '../src/db.js';

await mkdir(new URL('../.wrangler/',import.meta.url),{recursive:true});
await build({entryPoints:[new URL('../src/worker.js',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.html':'text'},outfile:new URL('../.wrangler/test-worker.mjs',import.meta.url).pathname});
const {default:worker,processApproval,TelegramError,handleUpdate}=await import('../.wrangler/test-worker.mjs');
test('HTTP endpoints reject unsigned admin and webhook requests before reaching the database',async()=>{
 const env={BOT_TOKEN:'test-token',ADMIN_ID:123};
 assert.equal((await worker.fetch(new Request('https://bot.test/',{method:'HEAD'}),env)).status,200);
 for (const action of ['all','cancel','auto-on','auto-off']) {
  assert.equal((await worker.fetch(new Request('https://bot.test/api/admin/'+action,{method:'POST'}),env)).status,403);
 }
 assert.equal((await worker.fetch(new Request('https://bot.test/telegram-webhook',{method:'POST',body:'{}'}),env)).status,403);
 assert.equal((await worker.fetch(new Request('https://bot.test/admin'),env)).status,200);
});
test('1200 approvals survive duplicate delivery, rate limits, and a failed storage transaction',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const db=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await db.connect();
 try{
  // These connection-local temporary tables shadow production. No real users are touched.
  for(const name of ['users','join_requests','cf_approval_jobs','cf_updates','cf_bot_settings'])await db.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
  await db.query(`INSERT INTO join_requests(user_id,first_name,status,requested_at) SELECT n,'Fixture','pending','2026-11-04 00:00:00' FROM generate_series(1,1200) n`);
  const {job}=await createJob(db,await pending(db),null);
  const sent=[];const env={BOT_TOKEN:'test',CHANNEL_ID:-100,APPROVAL_QUEUE:{send:async(data,opts)=>sent.push([data,opts])}};
  let apiCalls=0,first=true,max=0,active=0;
  const api=async(_,body)=>{apiCalls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,1));active--;if(first&&body.user_id===1)throw new TelegramError({error_code:429,parameters:{retry_after:10}});return true;};
  await processApproval(db,env,job.id,api);first=false;
  let saved=(await db.query('SELECT * FROM cf_approval_jobs WHERE id=$1',[job.id])).rows[0];
  assert.equal(saved.counts.approved,39);assert.equal(saved.pending_ids.length,1161);assert.equal(sent[0][1].delaySeconds,11);
  const before=apiCalls;assert.ok((await processApproval(db,env,job.id,api)).retry);assert.equal(apiCalls,before);
  await db.query('UPDATE cf_approval_jobs SET not_before=now() WHERE id=$1',[job.id]);
  await db.query("UPDATE cf_approval_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1",[job.id]);
  assert.ok((await processApproval(db,env,job.id,api)).retry);assert.equal(apiCalls,before);
  await db.query('UPDATE cf_approval_jobs SET lease_until=NULL WHERE id=$1',[job.id]);
  let iterations=0;
  while((await db.query('SELECT status FROM cf_approval_jobs WHERE id=$1',[job.id])).rows[0].status==='running'){
   assert.ok(++iterations<60);await processApproval(db,env,job.id,api);
  }
  assert.equal(iterations,30);
  saved=(await db.query('SELECT * FROM cf_approval_jobs WHERE id=$1',[job.id])).rows[0];assert.equal(saved.counts.approved,1200);assert.equal(saved.pending_ids.length,0);assert.equal((await pending(db)).length,0);assert.equal(max,40);
  const doneCalls=apiCalls;assert.ok((await processApproval(db,env,job.id,api)).done);assert.equal(apiCalls,doneCalls);
  await db.query("INSERT INTO join_requests(user_id,status,requested_at) VALUES(1201,'pending','2026-11-04 00:00:00')");
  const next=(await createJob(db,await pending(db),null)).job;
  const broken={query:(sql,args)=>{if(sql.startsWith('UPDATE join_requests jr'))throw Error('simulated storage interruption');return db.query(sql,args);}};
  await assert.rejects(processApproval(broken,env,next.id,api));
  assert.equal((await pending(db)).length,1);assert.equal((await db.query('SELECT counts FROM cf_approval_jobs WHERE id=$1',[next.id])).rows[0].counts.approved,0);
  await processApproval(db,env,next.id,async()=>{throw new TelegramError({error_code:400,description:'USER_ALREADY_PARTICIPANT'});});
  assert.equal((await pending(db)).length,0);
 }finally{await db.end();}
});

test('cancellation preserves pending requests and auto-approval applies only to new enabled arrivals', {skip:!process.env.TEST_DATABASE_URL}, async () => {
 const {cancelApprovals,setAutoApproval,autoApprovalEnabled,saveJoin,createAutoJob} = await import('../src/db.js');
 const db = new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
 await db.connect();
 try {
  for (const table of ['users','join_requests','cf_approval_jobs','cf_updates','cf_bot_settings']) {
   await db.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await db.query('INSERT INTO cf_bot_settings(id) VALUES(1)');
  const queued = [];
  const env = {BOT_TOKEN:'test',ADMIN_ID:999,CHANNEL_ID:-100,APPROVAL_QUEUE:{send:async body=>queued.push(body)}};
  const command = (text, userId=999) => handleUpdate(db,env,{message:{text,from:{id:userId},chat:{id:userId,type:'private'}}},async()=>true);
  const arrive = id => saveJoin(db,{from:{id,first_name:'Fixture'},date:1795600000,user_chat_id:id});
  assert.equal(await autoApprovalEnabled(db), false);
  assert.equal(await arrive(1), false);
  await db.query(`INSERT INTO join_requests(user_id,status,requested_at)
   SELECT n,'pending','fixture' FROM generate_series(2,100) n`);
  const manual = (await createJob(db,await pending(db),null)).job;
  let calls = 0;
  const cancellationReplies = [];
  const api = async (method, body) => {
   if (method === 'sendMessage') {cancellationReplies.push(body.text);return true;}
   calls++;
   if (calls === 1) await command('⏹ Cancel approvals');
   return true;
  };
  await processApproval(db,env,manual.id,api);
  assert.equal(calls,40);
  assert.equal((await pending(db)).length,60);
  const stopped=(await db.query('SELECT * FROM cf_approval_jobs WHERE id=$1',[manual.id])).rows[0];
  assert.equal(stopped.status,'cancelled');
  assert.equal(stopped.counts.approved,40);
  assert.ok(cancellationReplies.some(text=>text.includes('Approved now: 40') && text.includes('Saved pending remaining: 60')));
  assert.match(stopped.result,/Approved now: 40/);
  await processApproval(db,env,manual.id,api);
  assert.equal(calls,40);
  assert.equal(queued.some(body=>body.jobId===manual.id),false);

  await command('🟢 Auto-approval ON',998);
  assert.equal(await autoApprovalEnabled(db),false);
  await command('🟢 Auto-approval ON');
  assert.equal(await autoApprovalEnabled(db),true);
  assert.equal(await createAutoJob(db),null);
  assert.equal(await arrive(201),true);
  const automatic=await createAutoJob(db);
  assert.equal(automatic.auto_job,true);
  assert.deepEqual(automatic.pending_ids.map(row=>row.id),[201]);
  assert.equal(await arrive(202),true);
  await processApproval(db,env,automatic.id,async()=>true);
  const next=await createAutoJob(db);
  assert.deepEqual(next.pending_ids.map(row=>row.id),[202]);
  await command('🔴 Auto-approval OFF');
  const before=calls;
  await processApproval(db,env,next.id,api);
  assert.equal(calls,before);
  assert.ok((await pending(db)).some(row=>row.id===202));
  await setAutoApproval(db,true);
  assert.equal(await createAutoJob(db),null);
  await arrive(203);
  const failure=await createAutoJob(db);
  await processApproval(db,env,failure.id,async()=>{
   throw new TelegramError({error_code:400,description:'USER_CHANNELS_TOO_MUCH'});
  });
  assert.equal(await createAutoJob(db),null);
  assert.ok((await pending(db)).some(row=>row.id===203 && row.approval_failed));
  const manualAgain=(await createJob(db,await pending(db),null)).job;
  await setAutoApproval(db,false);
  assert.equal((await db.query('SELECT status FROM cf_approval_jobs WHERE id=$1',[manualAgain.id])).rows[0].status,'running');
  await cancelApprovals(db);
  const small=(await createJob(db,(await pending(db)).slice(0,6),null)).job;
  const remainingBefore=(await pending(db)).length;
  let smallCalls=0;
  await processApproval(db,env,small.id,async(method)=>{
   if (method === 'sendMessage') return true;
   if (++smallCalls===1) await command('⏹ Cancel approvals');
   return true;
  });
  assert.equal((await db.query('SELECT status FROM cf_approval_jobs WHERE id=$1',[small.id])).rows[0].status,'cancelled');
  assert.equal((await pending(db)).length,remainingBefore-6);
 } finally {
  await db.end();
 }
});
