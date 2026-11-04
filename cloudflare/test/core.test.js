import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hmac,hex,validateAdmin,webhookSecret,TelegramError,approveChunk,requestsMessage,memberInside,channelMatches} from '../src/core.js';
const token='test-token';
async function session(fields){const p=new URLSearchParams(fields);const key=await hmac('WebAppData',token);p.set('hash',hex(await hmac(key,[...p].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n'))));return p.toString();}
test('Telegram authentication rejects other users, expired, tampered and duplicate fields',async()=>{
 const data=await session({auth_date:'1000',user:JSON.stringify({id:123})});
 assert.equal(await validateAdmin(data,token,123,1000),true);
 assert.equal(await validateAdmin(data,token,456,1000),false);
 assert.equal(await validateAdmin(data,token,123,5000),false);
 assert.equal(await validateAdmin(data,token,123,900),false);
 assert.equal(await validateAdmin(data+'&user=%7B%22id%22%3A123%7D',token,123,1000),false);
 assert.equal(await validateAdmin(data.replace('1000','1001'),token,123,1000),false);
 assert.equal(await validateAdmin('',token,123),false);
});
test('webhook secret remains compatible with existing Telegram configuration',async()=>{
 const {createHash}=await import('node:crypto');assert.equal(await webhookSecret(token),createHash('sha256').update('miniapp-webhook:'+token).digest('hex'));
});
test('32 approvals run concurrently; rate limited and transient calls remain retryable',async()=>{
 let active=0,max=0;const rows=Array.from({length:32},(_,id)=>({id,requested:'same'}));
 const api=async(_,r)=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,1));active--;
 if(r.user_id===0)throw new TelegramError({error_code:429,parameters:{retry_after:12}});
 if(r.user_id===1)throw new TelegramError({error_code:400,description:'USER_ALREADY_PARTICIPANT'});
 if(r.user_id===2)throw new TelegramError({error_code:400,description:'HIDE_REQUESTER_MISSING'});
 if(r.user_id===3)throw new TelegramError({error_code:400,description:'USER_CHANNELS_TOO_MUCH'});
 if(r.user_id===4)throw Error('network');};
 const {results,cooldown}=await approveChunk(rows,api,-100);assert.equal(max,32);assert.equal(cooldown,12);
 assert.deepEqual(results.slice(0,5).map(r=>r.result),['retry','already_inside','resolved','failed','retry']);assert.equal(results.filter(r=>r.result==='approved').length,27);
});
test('request list is bounded and member handling preserves restricted membership',()=>{
 const rows=Array.from({length:1000},(_,id)=>({id,name:'X'.repeat(200),started:id%2,username:null}));
 const text=requestsMessage(rows);assert.ok(text.length<4096);assert.match(text,/1000/);assert.match(text,/995 more/);
 assert.equal(memberInside({status:'restricted',is_member:true}),true);assert.equal(memberInside({status:'restricted',is_member:false}),false);
 assert.equal(channelMatches({id:-123},'-123'),true);assert.equal(channelMatches({id:1,username:'Alpha'},'@alpha'),true);
});
