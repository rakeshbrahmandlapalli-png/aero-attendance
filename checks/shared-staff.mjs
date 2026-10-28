// Step 4: real namespaced SQL, executed as ordinary staff in two fake tenants.
import assert from 'node:assert/strict';
import {as} from './harness.mjs';
import {bootShared, seedStaff, committed, id} from './shared-fixture.mjs';
const db = await bootShared();
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const q = (user, sql, args) => committed(db, user, sql, args);
const denied = async (user, sql, args, pattern) => {
  const r = await as(db, user, sql, args);
  check(r.error && (!pattern || pattern.test(r.error)), 'Expected denial: ' + sql + ': ' + r.error);
};
const rpc = async (user, name, args = [], placeholders = '') =>
  (await q(user, `select to_jsonb(aero_${name}(${placeholders})) result`, args))[0].result;
try {
  await seedStaff(db);
  check((await q(id(10), 'select aero_is_manager() m'))[0].m === false, 'Acceptance user is staff');
  const parkingBefore = (await db.query('select * from staff order by id')).rows;
  await denied(id(10), 'select aero_clock_in($1,null,null,null)', [id(102)], /Unknown worksite/);
  const open = await rpc(id(10), 'clock_in', [id(101)], '$1,null,null,null');
  check(open.user_id === id(10) && open.company_id === id(1), 'Clock-in has canonical tenant and caller');
  check(open.clock_in_ok === null, 'Synthetic no-location fixture records unverified clock-in');
  check((await rpc(id(10), 'clock_in', [id(101)], '$1,null,null,null')).id === open.id, 'Clock-in retry returns same row');
  check((await rpc(id(10), 'open_shift')).id === open.id, 'Current-shift endpoint shows own row');
  check(await rpc(id(11), 'open_shift') === null, 'Colleague cannot see another person current shift');
  check(await rpc(id(20), 'open_shift') === null, 'Other tenant cannot see current shift');
  await denied('anon', 'select aero_open_shift()');
  const started = await rpc(id(10), 'start_break');
  check(!!started.break_started_at, 'Start break persisted');
  check((await rpc(id(10), 'start_break')).break_started_at === started.break_started_at, 'Repeated start does not reset break');
  await db.query("update aero_shifts set break_started_at=now()-interval '7 minutes' where id=$1", [open.id]);
  const ended = await rpc(id(10), 'end_break');
  check(ended.break_started_at === null && ended.break_minutes === 7, 'End break records elapsed minutes once');
  await denied(id(10), 'select aero_end_break()', [], /not on a break/);
  const closed = await rpc(id(10), 'clock_out', ['Example shift note'], 'null,null,$1');
  check(!!closed.clock_out_at && closed.break_minutes === 7 && closed.note === 'Example shift note', 'Clock-out preserves break and note');
  check(await rpc(id(10), 'open_shift') === null, 'Clock-out clears current shift');
  await denied(id(10), 'select aero_clock_out()', [], /not clocked in/);
  const start = new Date(Date.now() - 7200000).toISOString();
  const end = new Date(Date.now() - 3600000).toISOString();
  await denied(id(11), 'select aero_request_shift_correction($1,$2,$3,$4)', [open.id, start, end, 'Other person'], /Shift not found/);
  await denied(id(20), 'select aero_request_shift_correction($1,$2,$3,$4)', [open.id, start, end, 'Other tenant'], /Shift not found/);
  for (const values of [[end, start, 'Backwards'], [start, new Date(Date.now()+3600000).toISOString(), 'Future'], [start, end, ' ']]) {
    await denied(id(10), 'select aero_request_shift_correction($1,$2,$3,$4)', [open.id, ...values]);
  }
  const correction = await rpc(id(10), 'request_shift_correction', [open.id, start, end, 'Forgot the start time'], '$1,$2,$3,$4');
  check(correction.status === 'pending' && correction.user_id === id(10), 'Correction awaits review under staff identity');
  await denied(id(10), 'select aero_request_shift_correction($1,$2,$3,$4)', [open.id, start, end, 'Duplicate'], /pending correction/);
  check((await q(id(10), 'select * from aero_shift_corrections')).length === 1, 'Staff can read their request');
  check((await q(id(11), 'select * from aero_shift_corrections')).length === 0, 'Colleague cannot read request');
  check((await q(id(20), 'select * from aero_shift_corrections')).length === 0, 'Other tenant cannot read request');
  await denied(id(10), 'select aero_review_shift_correction($1,true,$2)', [correction.id, 'Self approval'], /Manager access/);
  check((await db.query('select clock_in_at,break_minutes from aero_shifts where id=$1', [open.id])).rows[0].break_minutes === 7, 'Request does not alter recorded break');

  // Keep a colleague's open shift as a witness throughout revocation/finishing.
  const colleague = await rpc(id(11), 'clock_in', [id(101)], '$1,null,null,null');
  const revoked = await rpc(id(10), 'clock_in', [id(101)], '$1,null,null,null');
  await rpc(id(10), 'start_break');
  await db.query("update aero_shifts set break_started_at=now()-interval '5 minutes' where id=$1", [revoked.id]);
  await db.query('update private.attendance_testers set active=false where user_id=$1', [id(10)]);
  for (const table of ['profiles', 'shifts', 'worksites', 'shift_corrections']) {
    check((await q(id(10), 'select * from aero_' + table)).length === 0, 'Revoked staff cannot read ' + table);
  }
  check((await rpc(id(10), 'open_shift')).id === revoked.id, 'Revoked staff can find only their own open shift');
  check(await rpc(id(12), 'open_shift') === null, 'Non-tester cannot finish somebody else shift');
  await denied(id(10), 'select aero_clock_in($1,null,null,null)', [id(101)]);
  await denied(id(10), 'select aero_start_break()', [], /not available/);
  await denied(id(10), 'select aero_request_shift_correction($1,$2,$3,$4)', [open.id, start, end, 'Revoked']);
  const finishedBreak = await rpc(id(10), 'end_break');
  check(finishedBreak.break_minutes === 5 && finishedBreak.break_started_at === null, 'Revoked staff can end existing break');
  const finished = await rpc(id(10), 'clock_out');
  check(!!finished.clock_out_at && finished.clock_out_ok === null && finished.break_minutes === 5, 'Revoked staff can finish shift without location');
  check(await rpc(id(10), 'open_shift') === null, 'Finish-only access exhausted after clock-out');
  await denied(id(10), 'select aero_clock_out()', [], /not clocked in/);
  check((await rpc(id(11), 'open_shift')).id === colleague.id, 'Finishing never touches colleague shift');

  // Clocking out during a break must finish that break, including after revoke.
  await db.query('update private.attendance_testers set active=true where user_id=$1', [id(10)]);
  const final = await rpc(id(10), 'clock_in', [id(101)], '$1,null,null,null');
  await rpc(id(10), 'start_break');
  await db.query("update aero_shifts set break_started_at=now()-interval '3 minutes' where id=$1", [final.id]);
  await db.query('update private.attendance_testers set active=false where user_id=$1', [id(10)]);
  const finalClosed = await rpc(id(10), 'clock_out');
  check(finalClosed.break_minutes === 3 && finalClosed.break_started_at === null, 'Finish-only clock-out closes an ongoing break');
  assert.deepEqual((await db.query('select * from staff order by id')).rows, parkingBefore); checks++;
  console.log(`${checks} shared staff workflow checks passed (synthetic PostgreSQL; no live Auth/API/GPS).`);
} finally { await db.close(); }
