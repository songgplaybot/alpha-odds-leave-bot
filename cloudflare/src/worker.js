import adminHtml from '../../miniapp.html';
import {connect,pending,saveUser,saveJoin,markMember,markResults,latestJob,state,createJob} from './db.js';
import {WORKERS,SECTION_SIZE,replyKeyboard,inlineKeyboard,validateAdmin,webhookSecret,equal,telegram,TelegramError,approveChunk,requestsMessage,jobResult,memberInside,channelMatches} from './core.js';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const report=e=>console.error('Bot operation failed:',e instanceof TelegramError?'Telegram '+e.code:e?.code||e?.name||'Error');
async function withDb(env,fn){const db=await connect(env);try{return await fn(db);}finally{await db.end();}}
async function enqueue(env,id,delay=0){await env.APPROVAL_QUEUE.send({jobId:id},{delaySeconds:Math.min(86400,Math.max(0,Math.ceil(delay)))});}
async function launch(db,env,mode,chatId,singleId){
 const rows=await pending(db);const selected=rows.filter(r=>(mode!=='started'||r.started)&&(!singleId||String(r.id)===String(singleId)));
 const {job,existing}=await createJob(db,selected,chatId);if(job)await enqueue(env,job.id);
 return !job?'No pending requests to approve.':existing?'⏳ Approval is already running. You can use Refresh to check progress.':`⏳ Starting approval for ${selected.length} pending request(s)…`;
}
async function optionalApi(api,method,payload){try{return await api(method,payload);}catch(e){if(e instanceof TelegramError&&(e.code===400||e.code===403))return null;throw e;}}
async function handleUpdate(db,env,u,api){
 const j=u.chat_join_request;
 if(j&&channelMatches(j.chat,env.CHANNEL_ID)){
  await saveJoin(db,j);
  if(j.user_chat_id)await optionalApi(api,'sendMessage',{chat_id:j.user_chat_id,text:`Welcome to Alpha Odds, ${j.from.first_name}! 🏆🔥\n\nLet’s get you ready—tap Start Bot ✅ below to activate your bot access. It only takes a few seconds! 🚀`,reply_markup:{inline_keyboard:[[{text:'Start Bot ✅',url:`https://t.me/${env.BOT_USERNAME||'Alphaoddsleavebot'}?start=activate`}]]}});
  return;
 }
 const m=u.chat_member;
 if(m&&channelMatches(m.chat,env.CHANNEL_ID)){
  if(memberInside(m.new_chat_member))await markMember(db,m.new_chat_member.user.id);
  if(!['left','kicked'].includes(m.old_chat_member.status)&&['left','kicked'].includes(m.new_chat_member.status)){
   const id=m.new_chat_member.user.id;
   const link=await optionalApi(api,'createChatInviteLink',{chat_id:env.CHANNEL_ID,name:'rejoin-'+id,member_limit:1,creates_join_request:false});
   if(link)await optionalApi(api,'sendMessage',{chat_id:id,text:`You just left Alpha Odds 🏆\n\nIf this was a mistake, you can join back directly here:\n\n${link.invite_link}\n\nThis link is for one use only. We’ll be waiting for you 🔥`});
  }return;
 }
 const q=u.callback_query,msg=u.message||q?.message,user=q?.from||msg?.from;
 if(!msg||!user||msg.chat?.type!=='private')return;
 const admin=String(user.id)===String(env.ADMIN_ID),text=msg.text||'',command=text.split(/\s/)[0].split('@')[0];
 const send=(text,extra={})=>api('sendMessage',{chat_id:msg.chat.id,text,reply_markup:admin?replyKeyboard:undefined,...extra});
 if(q){await optionalApi(api,'answerCallbackQuery',{callback_query_id:q.id,text:admin?(q.data==='admin_requests'?'Refreshing request list…':undefined):'You are not allowed to use this button.',show_alert:!admin});if(!admin)return;}
 if(!q&&command==='/start'){
  await saveUser(db,user);
  if(admin){await send('🏆 Alpha Odds Admin Panel\n\nYour admin buttons are now active under your typing box.\n\nChoose what you want to do:');await send('Admin quick buttons:',{reply_markup:inlineKeyboard});}
  else await send('Welcome to Alpha Odds 🏆\n\nYour bot access has been activated successfully ✅\n\nNow we can send you a direct one-use rejoin link here if you ever leave the channel.');
  return;
 }
 if(!q&&command==='/myid'){await send(`Your Telegram User ID is:\n\n${user.id}`);return;}
 if(!admin){if(command.startsWith('/'))await send('❌ You are not allowed to use this command.');return;}
 const action=q?.data||command;
 if(action==='admin_requests'||['/requests','📌','🔄'].includes(action)){
  let message;try{message=requestsMessage(await pending(db));}catch{message='⚠️ The database is unavailable right now. Your request list could not be refreshed. Please try again.';}
  if(q)await optionalApi(api,'editMessageText',{chat_id:msg.chat.id,message_id:msg.message_id,text:message+'\n\nRefreshed: '+new Date().toISOString().slice(11,19)+' UTC',reply_markup:inlineKeyboard});
  else await send(message);return;
 }
 if(action==='admin_myid'||command==='🆔'){await send(`🆔 Your Telegram User ID is:\n\n${user.id}`);return;}
 if(['admin_accept_all','admin_accept_started','/accept_all','/accept_started','⚠️','✅','/accept'].includes(action)){
  const id=command==='/accept'?text.trim().split(/\s+/)[1]:null;
  if(command==='/accept'&&!/^\d+$/.test(id||'')){await send('Use it like this:\n/accept 123456789');return;}
  const mode=action.includes('started')||command==='✅'?'started':'all';await send(await launch(db,env,mode,msg.chat.id,id));return;
 }
 if(['/panel','/menu','🏆'].includes(action)){await send('🏆 Alpha Odds Admin Panel\n\nYour buttons are active under your typing box.');await send('Admin quick buttons:',{reply_markup:inlineKeyboard});}
}
async function webhook(request,env){
 if(!equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),await webhookSecret(env.BOT_TOKEN)))return json({error:'Forbidden'},403);
 if(Number(request.headers.get('content-length')||0)>1048576)return json({error:'Too large'},413);
 let u;try{const body=await request.text();if(body.length>1048576)throw Error();u=JSON.parse(body);if(!Number.isSafeInteger(u.update_id))throw Error();}catch{return json({error:'Invalid update'},400);}
 return withDb(env,async db=>{
  const lease=crypto.randomUUID();const claim=(await db.query(`INSERT INTO cf_updates(update_id,lease_id,lease_until) VALUES($1,$2,now()+interval '90 seconds')
   ON CONFLICT(update_id) DO UPDATE SET lease_id=$2,lease_until=now()+interval '90 seconds'
   WHERE NOT cf_updates.done AND cf_updates.lease_until<now() RETURNING update_id`,[u.update_id,lease])).rows;
  if(!claim.length){const saved=(await db.query('SELECT done FROM cf_updates WHERE update_id=$1',[u.update_id])).rows[0];return saved?.done?new Response('ok'):json({error:'Update is processing; retry'},503);}
  try{await handleUpdate(db,env,u,telegram(env.BOT_TOKEN));await db.query('UPDATE cf_updates SET done=true,lease_until=NULL WHERE update_id=$1 AND lease_id=$2',[u.update_id,lease]);return new Response('ok');}
  catch(e){await db.query('UPDATE cf_updates SET lease_until=now() WHERE update_id=$1 AND lease_id=$2',[u.update_id,lease]);throw e;}
 });
}
export async function processApproval(db,env,id,api=telegram(env.BOT_TOKEN)){
 const lease=crypto.randomUUID();const job=(await db.query(`UPDATE cf_approval_jobs SET lease_id=$2,lease_until=now()+interval '90 seconds',updated_at=now()
 WHERE id=$1 AND status='running' AND (lease_until IS NULL OR lease_until<now()) AND (not_before IS NULL OR not_before<=now()) RETURNING *`,[id,lease])).rows[0];
 if(!job){const current=(await db.query('SELECT status,lease_until,not_before FROM cf_approval_jobs WHERE id=$1',[id])).rows[0];
  if(current?.status==='running')return {retry:Math.max(2,Math.ceil((Math.max(new Date(current.lease_until||0),new Date(current.not_before||0))-Date.now())/1000))};return {done:true};}
 try{
  const processed=Object.values(job.counts).reduce((a,b)=>a+b,0);
  const chunk=job.pending_ids.slice(0,Math.min(WORKERS,SECTION_SIZE-(processed%SECTION_SIZE)));
  const {results,cooldown}=await approveChunk(chunk,api,env.CHANNEL_ID);
  const retries=results.filter(r=>r.result==='retry');const finished=results.filter(r=>r.result!=='retry');
  for(const r of finished){job.counts[r.result]++;if(r.result==='failed'&&job.errors.length<3)job.errors.push(`User ${r.id}: ${r.error}`);}
  const rest=[...retries.map(({id,requested})=>({id,requested})),...job.pending_ids.slice(chunk.length)];
  // Repeated 429/network failures remain retryable and never disappear from the saved pending list.
  const delay=cooldown?Math.min(86400,cooldown+1):0;
  await db.query('BEGIN');
  try{
   const owned=(await db.query('SELECT id FROM cf_approval_jobs WHERE id=$1 AND lease_id=$2 FOR UPDATE',[id,lease])).rowCount;if(!owned)throw Error('Approval lease changed');
   await markResults(db,finished);
   const remaining=(await db.query("SELECT count(*)::integer AS count FROM join_requests WHERE status='pending'")).rows[0].count;
   const result=rest.length?'':jobResult(job,remaining);
   await db.query(`UPDATE cf_approval_jobs SET pending_ids=$3::jsonb,counts=$4::jsonb,errors=$5::jsonb,status=$6,result=$7,
    lease_id=NULL,lease_until=NULL,not_before=now()+($8*interval '1 second'),updated_at=now() WHERE id=$1 AND lease_id=$2`,
    [id,lease,JSON.stringify(rest),JSON.stringify(job.counts),JSON.stringify(job.errors),rest.length?'running':'done',result,delay]);
   await db.query('COMMIT');
   if(rest.length){await enqueue(env,id,delay);return {done:false};}
   if(job.chat_id)await optionalApi(api,'sendMessage',{chat_id:job.chat_id,text:result,reply_markup:replyKeyboard});
   return {done:true};
  }catch(e){await db.query('ROLLBACK');throw e;}
 }catch(e){await db.query('UPDATE cf_approval_jobs SET lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2',[id,lease]);throw e;}
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  try{
   if(url.pathname==='/'&&['GET','HEAD'].includes(request.method))return request.method==='HEAD'?new Response(null):json({status:'ok',hosting:'Cloudflare Workers'});
   if(url.pathname==='/admin'&&request.method==='GET')return new Response(adminHtml,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
   if(url.pathname==='/telegram-webhook'&&request.method==='POST')return await webhook(request,env);
   if(url.pathname.startsWith('/api/admin/')&&request.method==='POST'){
    if(!await validateAdmin(request.headers.get('X-Telegram-Init-Data'),env.BOT_TOKEN,env.ADMIN_ID))return json({error:'Forbidden'},403);
    const action=url.pathname.split('/').pop();if(!['state','all','started'].includes(action))return json({error:'Not found'},404);
    return await withDb(env,async db=>{if(action!=='state')await launch(db,env,action,env.ADMIN_ID);return json(await state(db,env.ADMIN_ID));});
   }
   return json({error:'Not found'},404);
  }catch(e){report(e);return json({error:'The service is temporarily unavailable. Please retry.'},503);}
 },
 async queue(batch,env){for(const message of batch.messages){try{const result=await withDb(env,db=>processApproval(db,env,message.body.jobId));if(result.retry)message.retry({delaySeconds:Math.min(86400,result.retry)});else message.ack();}catch(e){report(e);message.retry({delaySeconds:15});}}},
 async scheduled(event,env,ctx){
  if(env.PUBLIC_URL)ctx.waitUntil((async()=>{
   const api=telegram(env.BOT_TOKEN),info=await api('getWebhookInfo',{});
   const expected=env.PUBLIC_URL.replace(/\/$/,'')+'/telegram-webhook';
   if(info.url!==expected)await api('setWebhook',{url:expected,secret_token:await webhookSecret(env.BOT_TOKEN),allowed_updates:['message','callback_query','chat_join_request','chat_member','my_chat_member','channel_post'],max_connections:8,drop_pending_updates:false});
  })().catch(report));
  ctx.waitUntil(withDb(env,async db=>{
  // Recover a saved job even if the process stopped between committing and sending its next queue message.
  const active=(await db.query("SELECT id FROM cf_approval_jobs WHERE status='running' AND (lease_until IS NULL OR lease_until<now()) AND (not_before IS NULL OR not_before<=now())")).rows;
  for(const j of active)await enqueue(env,j.id);
  await db.query("DELETE FROM cf_updates WHERE done AND created_at<now()-interval '7 days'");
 }).catch(report));}
};

export {TelegramError};
