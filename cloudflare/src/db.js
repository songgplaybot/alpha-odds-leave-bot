import pg from 'pg';
export async function connect(env) {
 const client=new pg.Client({connectionString:env.HYPERDRIVE?.connectionString||env.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:12000});
 await client.connect();return client;
}
const now=()=>new Date().toISOString().slice(0,19).replace('T',' ');
export async function pending(db){return (await db.query(`SELECT jr.user_id AS id,jr.username,jr.first_name,jr.last_name,jr.requested_at AS requested,
 CASE WHEN u.started_bot=1 THEN true ELSE false END AS started FROM join_requests jr LEFT JOIN users u ON jr.user_id=u.user_id
 WHERE jr.status='pending' ORDER BY jr.requested_at,jr.user_id`)).rows.map(r=>({...r,id:Number(r.id),name:[r.first_name,r.last_name].filter(Boolean).join(' ')||String(r.id)}));}
export async function saveUser(db,u){await db.query(`INSERT INTO users(user_id,username,first_name,last_name,started_bot,created_at) VALUES($1,$2,$3,$4,1,$5)
 ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,started_bot=1`,[u.id,u.username||null,u.first_name||null,u.last_name||null,now()]);}
export async function saveJoin(db,j){const u=j.from;await db.query(`INSERT INTO join_requests(user_id,username,first_name,last_name,user_chat_id,status,requested_at,approved_at)
 VALUES($1,$2,$3,$4,$5,'pending',$6,NULL) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,
 user_chat_id=excluded.user_chat_id,status='pending',requested_at=excluded.requested_at,approved_at=NULL`,[u.id,u.username||null,u.first_name||null,u.last_name||null,j.user_chat_id||null,new Date(j.date*1000).toISOString().slice(0,19).replace('T',' ')]);}
export async function markMember(db,id){await db.query("UPDATE join_requests SET status='approved',approved_at=$2 WHERE user_id=$1 AND status='pending'",[id,now()]);}
export async function markResults(db,results){const changed=results.filter(r=>['approved','already_inside','resolved'].includes(r.result));if(!changed.length)return;
 await db.query(`UPDATE join_requests jr SET status=x.status,approved_at=CASE WHEN x.status='approved' THEN $2 ELSE jr.approved_at END
 FROM jsonb_to_recordset($1::jsonb) AS x(id bigint,status text,requested text)
 WHERE jr.user_id=x.id AND jr.status='pending' AND jr.requested_at=x.requested`,[JSON.stringify(changed.map(r=>({id:r.id,status:r.result==='resolved'?'resolved':'approved',requested:r.requested}))),now()]);}
export async function latestJob(db){return (await db.query('SELECT * FROM cf_approval_jobs ORDER BY created_at DESC LIMIT 1')).rows[0]||null;}
export async function state(db,adminId){const [rows,job]=await Promise.all([pending(db),latestJob(db)]);const running=job?.status==='running';const processed=job?Object.values(job.counts).reduce((a,b)=>a+b,0):0;
 return {adminId:Number(adminId),total:rows.length,started:rows.filter(r=>r.started).length,requests:rows.map(({requested,first_name,last_name,...r})=>r),job:{running,result:job?.result||''},
 progress:{running,workers:32,section_size:50,total:job?.total||0,processed,section:job?Math.min(Math.floor(processed/50)+1,Math.ceil(job.total/50)):0,sections:job?Math.ceil(job.total/50):0}};
}
export async function createJob(db,selected,chatId){
 const active=(await db.query("SELECT * FROM cf_approval_jobs WHERE status='running' LIMIT 1")).rows[0];if(active)return {job:active,existing:true};
 if(!selected.length)return {job:null,existing:false};
 const id=crypto.randomUUID();const job=(await db.query(`INSERT INTO cf_approval_jobs(id,status,total,pending_ids,chat_id)
 VALUES($1,'running',$2,$3::jsonb,$4) ON CONFLICT DO NOTHING RETURNING *`,[id,selected.length,JSON.stringify(selected.map(({id,requested})=>({id,requested}))),String(chatId)])).rows[0];
 return {job:job||(await db.query("SELECT * FROM cf_approval_jobs WHERE status='running' LIMIT 1")).rows[0],existing:!job};
}
