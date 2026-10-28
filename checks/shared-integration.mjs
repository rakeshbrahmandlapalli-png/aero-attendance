import {as} from './harness.mjs';
import {bootShared} from './shared-fixture.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db=await bootShared();
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
for(const n of [1,2]) {
 await db.query("insert into companies(id,name,brand) values($1,$2,'{\"attendance\":true}')",[id(n),'Company '+n]);
 await db.query('insert into aero_companies(id,name) values($1,$2)',[id(n),'Company '+n]);
 for(const member of [n*10,n*10+1]) {
  await db.query('insert into auth.users(id,email) values($1,$2)',[id(member),member+'@example.test']);
  await db.query("insert into staff(id,company_id,user_id,name) values($1,$2,$1,'Person')",[id(member),id(n)]);
  await db.query("insert into attendance_staff_links(company_id,staff_id,attendance_user_id) values($1,$2,$2)",[id(n),id(member)]);
  await db.query("insert into aero_profiles(id,company_id,full_name,role) values($1,$2,'Person',$3)",[id(member),id(n),member%10===0?'owner':'staff']);
 }
 await db.query('insert into private.attendance_testers(company_id,user_id) values($1,$2)',[id(n),id(n*10)]);
 await db.query("insert into aero_worksites(id,company_id,name,lat,lng) values($1,$2,'Yard',51.5,-0.1)",[id(100+n),id(n)]);
}
const q=async(user,sql,args=[])=>{const r=await as(db,user,sql,args);assert.equal(r.error,null,sql+': '+r.error);return r.rows;};
assert.equal((await q(id(10),'select * from aero_worksites')).length,1);
assert.equal((await q(id(11),'select * from aero_worksites')).length,0);
assert.equal((await q(id(10),'select id from aero_profiles')).length,2);
assert.equal((await q(id(10),'select aero_is_manager() m'))[0].m,true);
const forbidden=await as(db,id(10),'select aero_clock_in($1,51.5,-0.1,10)',[id(102)]);assert.ok(forbidden.error);
const clock=await q(id(10),'select to_jsonb(aero_clock_in($1,51.5,-0.1,10)) s',[id(101)]);assert.ok(clock[0].s.id);
assert.equal((await q(id(10),"select aero_has_feature('rota') f"))[0].f,false);
assert.equal((await q(id(11),'select * from aero_shifts')).length,0);
for(const table of ['aero_worksites','aero_shifts','aero_profiles','aero_companies','aero_shift_corrections','aero_audit_events']) {
 const r=await as(db,'anon','select * from '+table);assert.ok(r.error||r.rows.length===0,table);
}
console.log('Shared Attendance schema installs twice; tester gate, manager role, tenant isolation, clocking and deferred-feature checks passed');
const manifest=JSON.parse(read('../shared-names.json'));
for(const table of manifest.tables) {
 const columns=(await db.query("select column_name from information_schema.columns where table_schema='public' and table_name=$1",['aero_'+table])).rows.map(r=>r.column_name);
 if(!columns.includes('company_id'))continue;
 for(const person of [id(11),id(21)]) {
  const r=await as(db,person,'select * from aero_'+table);
  assert.ok(r.error||r.rows.length===0,'Non-tester read '+table);
 }
 const r=await as(db,id(10),'select * from aero_'+table+' where company_id=$1',[id(2)]);
 assert.ok(r.error||r.rows.length===0,'Cross-company read '+table);
}
const prefColumns=(await db.query("select column_name from information_schema.columns where table_name='aero_notification_prefs'")).rows.map(r=>r.column_name);
assert.ok(prefColumns.includes('clock_in')&&prefColumns.includes('clock_out'));
const forbiddenPush=await as(db,id(10),'select * from aero_push_recipients($1)',[[id(10),id(11)]]);assert.ok(forbiddenPush.error);
const allowedPush=(await db.query('select * from aero_push_recipients($1)',[[id(10),id(11)]])).rows;
assert.deepEqual(allowedPush,[{user_id:id(10)}]);
console.log('All namespaced company tables deny non-testers/other-company reads; preference columns and push-recipient isolation passed');
async function committed(user,sql,args=[]) {
 return db.transaction(async tx=>{
  await tx.exec('set local role authenticated');
  await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
  return (await tx.query(sql,args)).rows;
 });
}
await db.query('insert into private.attendance_testers(company_id,user_id) values($1,$2)',[id(1),id(11)]);
await db.query("insert into aero_shifts(id,company_id,user_id,worksite_id,clock_in_at,clock_out_at,break_minutes) values($1,$2,$3,$4,now()-interval '3 hours',now()-interval '1 hour',15)",[id(201),id(1),id(11),id(101)]);
const start=new Date(Date.now()-4*3600000).toISOString(),end=new Date(Date.now()-3600000).toISOString();
const request=(await committed(id(11),'select to_jsonb(aero_request_shift_correction($1,$2,$3,$4)) r',[id(201),start,end,'Forgot clock-in'] ))[0].r;
const self=await as(db,id(11),'select aero_review_shift_correction($1,true,$2)',[request.id,'Checked']);assert.ok(self.error);
await committed(id(10),'select aero_review_shift_correction($1,true,$2)',[request.id,'Checked']);
const changed=(await q(id(10),'select clock_in_at,break_minutes from aero_shifts where id=$1',[id(201)]))[0];
assert.equal(new Date(changed.clock_in_at).toISOString(),start);assert.equal(changed.break_minutes,15);
const other=await as(db,id(20),'select aero_review_shift_correction($1,true,$2)',[request.id,'Cross company']);assert.ok(other.error);
assert.ok((await q(id(10),'select * from aero_audit_events')).length>0);
const previous=(await db.query('select name,time_zone,brand from companies where id=$1',[id(1)])).rows[0];
await committed(id(10),"update aero_companies set privacy_contact='manager@example.test',time_zone='Europe/London' where id=$1",[id(1)]);
assert.deepEqual((await db.query('select name,time_zone,brand from companies where id=$1',[id(1)])).rows[0],previous);
await committed(id(11),'select aero_clock_in($1,51.5,-0.1,10)',[id(101)]);
await committed(id(11),'select aero_start_break()');
await db.query('update private.attendance_testers set active=false where user_id=$1',[id(11)]);
const finished=(await committed(id(11),'select to_jsonb(aero_clock_out(null,null,$1)) s',['Finished after pilot revoked']))[0].s;
assert.ok(finished.clock_out_at);assert.equal(finished.break_started_at,null);
assert.ok((await as(db,id(11),'select aero_clock_in($1,51.5,-0.1,10)',[id(101)])).error);
console.log('Staff-to-manager correction, audit, parking-settings preservation, breaks and revoked-access clock-out passed');
assert.ok((await as(db,id(11),'select aero_prepare_pilot($1,$2)',[id(11),'staff'])).error);
await db.exec(`create or replace function is_platform_admin() returns boolean language sql as $$select auth.uid()='${id(10)}'::uuid$$`);
const parkingBefore=(await db.query('select * from staff order by id')).rows;
await committed(id(10),'select aero_prepare_pilot($1,$2)',[id(10),'owner']);
await committed(id(10),'select aero_prepare_pilot($1,$2)',[id(10),'owner']);
assert.deepEqual((await db.query('select * from staff order by id')).rows,parkingBefore);
assert.ok((await as(db,id(10),'select aero_prepare_pilot($1,$2)',[id(10),'admin'])).error);
assert.ok((await as(db,id(10),'select aero_prepare_pilot($1,$2)',[id(10),'unexpected'])).error);
assert.ok((await as(db,id(10),'update aero_companies set use_rota=true where id=$1',[id(1)])).error);
assert.ok((await as(db,id(10),'update aero_companies set show_pay=true where id=$1',[id(1)])).error);
console.log('Pilot enrolment checks passed: platform-only, repeatable, preserves parking staff, refuses conflicting roles and blocks deferred settings');
await db.close();
