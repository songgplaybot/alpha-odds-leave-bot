import pg from 'pg';
import {WORKERS,jobResult} from './core.js';
export async function connect(env) {
 const client=new pg.Client({connectionString:env.HYPERDRIVE?.connectionString||env.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:12000});
 await client.connect();return client;
}
const now=()=>new Date().toISOString().slice(0,19).replace('T',' ');
export async function pending(db){return (await db.query(`SELECT jr.user_id AS id,jr.username,jr.first_name,jr.last_name,jr.requested_at AS requested,jr.approval_failed,jr.auto_eligible,
 CASE WHEN u.started_bot=1 THEN true ELSE false END AS started FROM join_requests jr LEFT JOIN users u ON jr.user_id=u.user_id
 WHERE jr.status='pending' ORDER BY jr.requested_at,jr.user_id`)).rows.map(r=>({...r,id:Number(r.id),name:[r.first_name,r.last_name].filter(Boolean).join(' ')||String(r.id)}));}
export async function saveUser(db,u){await db.query(`INSERT INTO users(user_id,username,first_name,last_name,started_bot,created_at) VALUES($1,$2,$3,$4,1,$5)
 ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,started_bot=1`,[u.id,u.username||null,u.first_name||null,u.last_name||null,now()]);}
export async function saveJoin(db,j){const u=j.from;const saved = await db.query(`INSERT INTO join_requests(user_id,username,first_name,last_name,user_chat_id,status,requested_at,approved_at,auto_eligible)
 VALUES($1,$2,$3,$4,$5,'pending',$6,NULL,(SELECT auto_approval FROM cf_bot_settings WHERE id=1 FOR SHARE)) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,
 user_chat_id=excluded.user_chat_id,status='pending',requested_at=excluded.requested_at,approved_at=NULL,approval_failed=false,auto_eligible=excluded.auto_eligible RETURNING auto_eligible`,[u.id,u.username||null,u.first_name||null,u.last_name||null,j.user_chat_id||null,new Date(j.date*1000).toISOString().slice(0,19).replace('T',' ')]);return saved.rows[0].auto_eligible;}
export async function markMember(db,id){await db.query("UPDATE join_requests SET status='approved',approved_at=$2 WHERE user_id=$1 AND status='pending'",[id,now()]);}
function requestChanges(results) {
 const statuses = {approved:'approved', already_inside:'approved', resolved:'resolved', terminal:'failed', failed:'pending'};
 return results.filter(r => Object.hasOwn(statuses, r.result)).map(r => ({
  id:r.id, status:statuses[r.result], requested:r.requested
 }));
}

const updateRequests = `UPDATE join_requests jr
 SET status=x.status, auto_eligible=false, approval_failed=(x.status='pending'), approved_at=CASE WHEN x.status='approved' THEN $2 ELSE jr.approved_at END
 FROM jsonb_to_recordset($1::jsonb) AS x(id bigint,status text,requested text)
 WHERE jr.user_id=x.id AND jr.status='pending' AND jr.requested_at=x.requested`;

export async function markResults(db, results) {
 const changed = requestChanges(results);
 if (changed.length) await db.query(updateRequests, [JSON.stringify(changed), now()]);
}

export async function saveApprovalBatch(db, job, lease, remaining, results, delay) {
 // Both writes commit together. Request changes only apply if we still own the job.
 const saved = await db.query(`WITH advanced AS (
  UPDATE cf_approval_jobs SET pending_ids=$5::jsonb,counts=$6::jsonb,errors=$7::jsonb,
   status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'running' END,
   result=CASE WHEN cancel_requested THEN 'Approval cancelled. Remaining requests stay pending.' ELSE result END,
   lease_id=NULL,lease_until=NULL,not_before=now()+($8*interval '1 second'),updated_at=now()
  WHERE id=$3 AND lease_id=$4 RETURNING id,status
 ), saved_requests AS (
  ${updateRequests} AND EXISTS (SELECT 1 FROM advanced)
  RETURNING jr.user_id
 )
 SELECT id,status FROM advanced`, [
  JSON.stringify(requestChanges(results)), now(), job.id, lease,
  JSON.stringify(remaining), JSON.stringify(job.counts), JSON.stringify(job.errors), delay
 ]);
 if (!saved.rowCount) throw Error('Approval lease changed');
 return saved.rows[0].status;
}
export async function latestJob(db){return (await db.query('SELECT * FROM cf_approval_jobs ORDER BY created_at DESC LIMIT 1')).rows[0]||null;}
export async function state(db,adminId){const [rows,job,autoApproval]=await Promise.all([pending(db),latestJob(db),autoApprovalEnabled(db)]);const running=job?.status==='running';const processed=job?Object.values(job.counts).reduce((a,b)=>a+b,0):0;
 return {autoApproval,adminId:Number(adminId),total:rows.length,started:rows.filter(r=>r.started).length,requests:rows.map(({requested,first_name,last_name,approval_failed,auto_eligible,...r})=>r),failedPending:rows.filter(r=>r.approval_failed).length,job:{running,stopping:running&&job.cancel_requested,result:job?.result||''},
 progress:{running,workers:WORKERS,section_size:50,total:job?.total||0,processed,section:job?Math.min(Math.floor(processed/50)+1,Math.ceil(job.total/50)):0,sections:job?Math.ceil(job.total/50):0}};
}
export async function createJob(db,selected,chatId,automatic=false){
 const active=(await db.query("SELECT * FROM cf_approval_jobs WHERE status='running' LIMIT 1")).rows[0];if(active)return {job:active,existing:true};
 if(!selected.length)return {job:null,existing:false};
 const id=crypto.randomUUID();const job=(await db.query(`INSERT INTO cf_approval_jobs(id,status,total,pending_ids,chat_id,auto_job)
 SELECT $1,'running',$2,$3::jsonb,$4,$5 WHERE NOT $5 OR (SELECT auto_approval FROM cf_bot_settings WHERE id=1 FOR SHARE) ON CONFLICT DO NOTHING RETURNING *`,[id,selected.length,JSON.stringify(selected.map(({id,requested})=>({id,requested}))),chatId == null ? null : String(chatId),automatic])).rows[0];
 return {job:job||(await db.query("SELECT * FROM cf_approval_jobs WHERE status='running' LIMIT 1")).rows[0],existing:!job};
}

export async function clearFailed(db) {
 const result = await db.query(`UPDATE join_requests SET status='dismissed', approval_failed=false
  WHERE status='pending' AND approval_failed
    AND NOT EXISTS (SELECT 1 FROM cf_approval_jobs WHERE status='running')`);
 return result.rowCount;
}

export async function autoApprovalEnabled(db) {
 return (await db.query('SELECT auto_approval FROM cf_bot_settings WHERE id=1')).rows[0]?.auto_approval === true;
}

export async function cancelApprovals(db, automaticOnly=false, jobId=null) {
 const cancelled = await db.query(`WITH stopped AS (
  UPDATE cf_approval_jobs SET cancel_requested=true,
   status=CASE WHEN lease_until>now() THEN 'running' ELSE 'cancelled' END,
   result='Approval cancelled. Remaining requests stay pending.',updated_at=now()
  WHERE status='running' AND (NOT $1 OR auto_job)
   AND ($2::uuid IS NULL OR id=$2) RETURNING pending_ids
 )
 UPDATE join_requests jr SET auto_eligible=false
 FROM stopped, jsonb_to_recordset(stopped.pending_ids) AS item(id bigint,requested text)
 WHERE jr.user_id=item.id AND jr.requested_at=item.requested RETURNING jr.user_id`,[automaticOnly,jobId]);
 return cancelled.rowCount;
}

export async function setAutoApproval(db, enabled) {
 await db.query('BEGIN');
 try {
  await db.query('UPDATE cf_bot_settings SET auto_approval=$1 WHERE id=1',[enabled]);
  if (!enabled) {
   await cancelApprovals(db, true);
   await db.query('UPDATE join_requests SET auto_eligible=false WHERE auto_eligible');
  }
  await db.query('COMMIT');
 } catch(error) {await db.query('ROLLBACK');throw error;}
 return enabled;
}

export async function createAutoJob(db) {
 if (!await autoApprovalEnabled(db)) return null;
 const selected=(await db.query(`SELECT user_id AS id,requested_at AS requested FROM join_requests
  WHERE status='pending' AND auto_eligible AND NOT approval_failed
  ORDER BY requested_at,user_id LIMIT $1`,[WORKERS])).rows.map(row=>({...row,id:Number(row.id)}));
 if (!selected.length) return null;
 const created = await createJob(db,selected,null,true);
 return created.existing ? null : created.job;
}

export async function cancellationSummary(db, jobId=null) {
 const {rows} = await db.query(`SELECT *,
  (SELECT count(*)::integer FROM join_requests WHERE status='pending') AS remaining
  FROM cf_approval_jobs WHERE cancel_requested AND ($1::uuid IS NULL OR id=$1)
  ORDER BY updated_at DESC LIMIT 1`,[jobId]);
 const job = rows[0];
 if (!job) return null;
 const stopping = job.status === 'running';
 const title = stopping ? '⏹ Stopping approvals.' : '⏹ Approval cancelled.';
 let result = jobResult(job,job.remaining).replace('✅ Approval finished.',title);
 if (stopping) result += '\n\nApprovals already sent may finish. Final counts will follow.';
 else await db.query("UPDATE cf_approval_jobs SET result=$2 WHERE id=$1 AND status='cancelled'",[job.id,result]);
 return {job,result};
}
