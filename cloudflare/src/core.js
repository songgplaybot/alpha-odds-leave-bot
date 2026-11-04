export const WORKERS = 32;
export const SECTION_SIZE = 50;
export const replyKeyboard = {keyboard:[['📌 Requests','✅ Accept Started'],['⚠️ Accept All','🆔 My ID'],['🔄 Refresh','🏆 Admin Panel']],resize_keyboard:true,is_persistent:true};
export const inlineKeyboard = {inline_keyboard:[[{text:'📌 Requests',callback_data:'admin_requests'},{text:'✅ Accept Started',callback_data:'admin_accept_started'}],[{text:'⚠️ Accept All',callback_data:'admin_accept_all'}],[{text:'🆔 My ID',callback_data:'admin_myid'},{text:'🔄 Refresh',callback_data:'admin_requests'}]]};
const enc = new TextEncoder();
export async function hmac(key,data) {
 const k=await crypto.subtle.importKey('raw',typeof key==='string'?enc.encode(key):key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode(data)));
}
export const hex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export function equal(a,b) {if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0;}
export async function webhookSecret(token) {return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode('miniapp-webhook:'+token))));}
export async function validateAdmin(data,token,adminId,now=Date.now()/1000) {
 if(!data||data.length>16384) return false;
 try {
  const p=new URLSearchParams(data), entries=[...p];if(new Set(entries.map(e=>e[0])).size!==entries.length)return false;
  const signature=p.get('hash');p.delete('hash');const key=await hmac('WebAppData',token);
  const expected=hex(await hmac(key,[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n')));
  const age=now-Number(p.get('auth_date'));
  return equal(signature,expected)&&Number.isFinite(age)&&age>=-30&&age<=3600&&String(JSON.parse(p.get('user')).id)===String(adminId);
 }catch{return false;}
}
export class TelegramError extends Error {constructor(data){super(data.description||'Telegram request failed');this.code=data.error_code;this.retryAfter=data.parameters?.retry_after||0;}}
export function telegram(token,fetcher=fetch) {return async(method,body)=>{
 const response=await fetcher('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 const data=await response.json();if(!data.ok)throw new TelegramError(data);return data.result;
};}
export function classify(error) {
 const text=error.message.toLowerCase().replaceAll('_',' ');
 if(text.includes('already participant')||text.includes('already a participant'))return 'already_inside';
 if(error.code===400&&(text.includes('hide requester missing')||text.includes('join request not found')))return 'resolved';
 return 'failed';
}
export async function approveChunk(items,api,channelId) {
 // A chunk fits below the Free plan's outbound-request limit. All workers share a cooldown.
 let cooldown=0;const results=await Promise.all(items.map(async item=>{
  try{await api('approveChatJoinRequest',{chat_id:channelId,user_id:item.id});return {...item,result:'approved'};}
  catch(e){if(e.retryAfter){cooldown=Math.max(cooldown,e.retryAfter);return {...item,result:'retry'};}
   // Network failures and server errors may have succeeded: preserve for a retry.
   if(!(e instanceof TelegramError)||e.code>=500){cooldown=Math.max(cooldown,5);return {...item,result:'retry'};}
   return {...item,result:classify(e),error:e.message.slice(0,180)};
  }
 }));return {results,cooldown};
}
export function requestsMessage(rows) {
 let text=`📌 Saved pending requests: ${rows.length}\n`;if(!rows.length)return text+'\nNo saved pending requests.';
 for(const r of rows.slice(0,5))text+=`\n${r.started?'✅':'⏳'} ${r.name.slice(0,60)} · ${r.username?'@'+r.username:r.id}`;
 if(rows.length>5)text+=`\n…and ${rows.length-5} more.`;
 return text+'\n\n✅ Started bot · ⏳ Not started\nResolved requests are removed during approval or when users join.';
}
export function jobResult(job,remaining) {
 const c=job.counts;let text=`✅ Approval finished.\n\nApproved now: ${c.approved}\nAlready inside: ${c.already_inside}\nNo longer pending: ${c.resolved}\nFailed (kept for retry): ${c.failed}\nSaved pending remaining: ${remaining}`;
 if(job.errors.length)text+='\n\nFirst errors:\n'+job.errors.slice(0,3).join('\n');return text;
}
export function memberInside(m){return ['member','administrator','creator'].includes(m.status)||(m.status==='restricted'&&m.is_member);}
export function channelMatches(chat,channel){return String(chat.id)===String(channel)||(chat.username&&('@'+chat.username).toLowerCase()===String(channel).toLowerCase());}
