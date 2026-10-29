// Step 5: actual shared SQL/RLS/RPCs, synthetic tenants, no live services.
import assert from 'node:assert/strict';
import {bootShared,committed} from './shared-fixture.mjs';
import {as} from './harness.mjs';
import {seedManager,id,manager,otherManager,cases} from './shared-manager-fixture.mjs';
const db=await bootShared();let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const q=(user,sql,args=[])=>committed(db,user,sql,args);
const denied=async(user,sql,args=[],pattern)=>{const r=await as(db,user,sql,args);check(r.error&&(!pattern||pattern.test(r.error)),sql+': '+r.error);};
const request=async(shift,user,start,end,reason)=>(await q(user,'select to_jsonb(aero_request_shift_correction($1,$2,$3,$4)) r',[shift,start,end,reason]))[0].r;
const review=async(user,req,approve,note='Checked example record')=>(await q(user,'select to_jsonb(aero_review_shift_correction($1,$2,$3)) r',[req,approve,note]))[0].r;
try {
  await seedManager(db);
  const parkingBefore=(await db.query('select to_jsonb(s) s from staff s order by id')).rows;
  for(const user of [manager,id(14),otherManager]) check((await q(user,'select aero_is_manager() m'))[0].m,'Eligible manager accepted');
  for(const user of [id(10),id(15),id(16)]) check(!(await q(user,'select aero_is_manager() m'))[0].m,'Staff/inactive/non-tester not managers');
  for(const table of ['profiles','shifts','shift_corrections','audit_events','worksites','on_shift_now']) {
    const rows=await q(manager,'select * from aero_'+table);
    check(rows.length>0,'Manager can read '+table);
    check(rows.every(r=>!r.company_id||r.company_id===id(1)),'Tenant isolation '+table);
    for(const user of [id(15),id(16)]) check((await q(user,'select * from aero_'+table)).length===0,'Inactive/non-tester cannot read '+table);
    const anon=await as(db,'anon','select * from aero_'+table);check(anon.error||anon.rows.length===0,'Anonymous blocked '+table);
  }
  check((await q(manager,'select * from aero_profiles where active=false')).length===2,'Removed staff and manager retain readable history');
  check((await q(id(10),'select * from aero_audit_events')).length===0,'Staff cannot read audit');
  check((await q(id(10),'select * from aero_shifts')).every(s=>s.user_id===id(10)),'Staff cannot read manager timesheet data');
  const all=(await q(manager,'select * from aero_shift_corrections order by reason'));
  const approval=all.find(r=>r.reason==='Example approval'), rejection=all.find(r=>r.reason==='Example rejection'), own=all.find(r=>r.user_id===manager);
  for(const user of [id(10),otherManager,id(15),id(16),'anon']) await denied(user,'select aero_review_shift_correction($1,true,$2)',[approval.id,'Forbidden']);
  await denied(manager,'select aero_review_shift_correction($1,true,$2)',[own.id,'Self approval'],/Another manager/);
  const foreign=(await db.query("select id from aero_shift_corrections where reason='Other tenant correction'")).rows[0].id;
  await denied(manager,'select aero_review_shift_correction($1,false,$2)',[foreign,'Cross tenant'],/Correction not found/);
  await denied(manager,'select aero_review_shift_correction($1,null,$2)',[approval.id,'No choice'],/Choose approve or reject/);
  await denied(manager,'select aero_review_shift_correction($1,true,$2)',[approval.id,'x'.repeat(1001)],/too long/);
  const approved=await review(manager,approval.id,true,'  Example checked  ');
  check(approved.status==='approved'&&approved.reviewed_by===manager&&approved.review_note==='Example checked'&&!!approved.reviewed_at,'Approval actor/time/note recorded');
  const changed=(await q(manager,'select * from aero_shifts where id=$1',[approval.shift_id]))[0];
  check(new Date(changed.clock_in_at).toISOString()===new Date(approval.requested_in).toISOString(),'Approval changes shift start');
  check(changed.break_minutes===30&&changed.note===cases[0].note,'Approval preserves recorded break and shift note');
  const recorded=(await q(manager,"select * from aero_audit_events where action='approved' and entity_id=$1",[approval.id]));
  check(recorded.length===1&&recorded[0].actor_id===manager&&recorded[0].details.review_note==='Example checked','Exactly one approval audit');
  await denied(manager,'select aero_review_shift_correction($1,false,$2)',[approval.id,'Replay'],/already been reviewed/);
  check((await q(manager,"select * from aero_audit_events where action='approved' and entity_id=$1",[approval.id])).length===1,'Replay does not duplicate audit');
  const before=(await db.query('select * from aero_shifts where id=$1',[rejection.shift_id])).rows[0];
  const rejected=await review(manager,rejection.id,false,'Example rejected');
  check(rejected.status==='rejected'&&rejected.reviewed_by===manager,'Rejection records manager');
  assert.deepEqual((await db.query('select * from aero_shifts where id=$1',[rejection.shift_id])).rows[0],before);checks++;
  check((await q(manager,"select * from aero_audit_events where action='rejected' and entity_id=$1",[rejection.id])).length===1,'Rejection audited once');
  await denied(manager,'select aero_review_shift_correction($1,true,$2)',[rejection.id,'Replay'],/already been reviewed/);
  const stale=await request(id(304),id(10),'2026-03-29T00:20:00Z','2026-03-29T01:30:00Z','Stale example');
  await db.query("update aero_shifts set clock_in_at=clock_in_at-interval '5 minutes' where id=$1",[id(304)]);
  await denied(manager,'select aero_review_shift_correction($1,true,$2)',[stale.id,'Stale'],/has changed/);
  check((await review(manager,stale.id,false)).status==='rejected','A stale request can be rejected');
  const overlap=await request(id(302),id(11),'2026-10-24T23:40:00Z','2026-10-25T01:30:00Z','Overlap example');
  await denied(manager,'select aero_review_shift_correction($1,true,$2)',[overlap.id,'Overlap'],/overlap/);
  check((await review(manager,overlap.id,false)).status==='rejected','Overlapping request remains rejectable');
  await denied(manager,"insert into aero_audit_events(company_id,action,entity,summary) values($1,'approved','shift_correction','Forged')",[id(1)]);
  await denied(manager,"update aero_audit_events set summary='Forged'");
  await denied(manager,'select aero_write_audit_event($1,$2,$3,$4,$5,$6)',[id(1),manager,'approved','shift_correction',approval.id,'Forged']);
  check((await q(otherManager,'select * from aero_audit_events')).every(e=>e.company_id===id(2)),'Other manager cannot read local audit');
  // Durations come from instants, not repeated/skipped wall-clock labels.
  for(const s of cases.filter(s=>[id(302),id(303),id(306)].includes(s.id))) {
    const r=(await q(manager,"select extract(epoch from(clock_out_at-clock_in_at))/3600-break_minutes/60.0 hours from aero_shifts where id=$1",[s.id]))[0];
    check(Number(r.hours).toFixed(2)===s.hours,'DST/overnight elapsed duration '+s.id);
  }
  for(const [date,count] of [['2026-03-29',2],['2026-10-25',4]]) {
    const r=await q(manager,"select id from aero_shifts where clock_in_at>=($1::date::timestamp at time zone 'Europe/London') and clock_in_at<(($1::date+1)::timestamp at time zone 'Europe/London')",[date]);
    check(r.length===count,'DST local day filter '+date+': '+r.length);
  }
  await db.query('update private.attendance_testers set active=false where user_id=$1',[manager]);
  check(!(await q(manager,'select aero_is_manager() m'))[0].m,'Revoked manager loses manager gate');
  for(const table of ['profiles','shifts','shift_corrections','audit_events']) check((await q(manager,'select * from aero_'+table)).length===0,'Revoked manager loses '+table);
  await denied(manager,'select aero_review_shift_correction($1,false,$2)',[own.id,'Revoked']);
  assert.deepEqual((await db.query('select to_jsonb(s) s from staff s order by id')).rows,parkingBefore);checks++;
  console.log(`${checks} shared manager SQL checks passed; no notification/GPS assertions or live services.`);
} finally {await db.close();}
