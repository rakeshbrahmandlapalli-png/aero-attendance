// Synthetic manager acceptance data. All fixtures are local, never enrolment.
import {seedStaff, committed, id} from './shared-fixture.mjs';
export {id};
export const manager = id(13), otherManager = id(23);
export const cases = [
  {id:id(301),user:id(10),start:'2026-10-24T21:00:00Z',end:'2026-10-25T06:00:00Z',breaks:30,note:'=SUM(1,2)\n"Example"',hours:'8.50'},
  {id:id(302),user:id(11),start:'2026-10-25T00:30:00Z',end:'2026-10-25T01:30:00Z',breaks:0,note:'Repeated hour',hours:'1.00'},
  {id:id(303),user:id(11),start:'2026-03-28T22:00:00Z',end:'2026-03-29T05:00:00Z',breaks:30,note:'Spring overnight',hours:'6.50'},
  {id:id(304),user:id(10),start:'2026-03-29T00:30:00Z',end:'2026-03-29T01:30:00Z',breaks:0,note:'Skipped hour',hours:'1.00'},
  {id:id(305),user:id(17),start:'2026-10-25T23:30:00Z',end:'2026-10-26T00:30:00Z',breaks:0,note:'Removed staff history',hours:'1.00'},
  {id:id(306),user:id(10),start:'2026-03-29T22:30:00Z',end:'2026-03-29T23:30:00Z',breaks:0,note:'Spring last local half-hour',hours:'1.00'},
  {id:id(307),user:id(11),start:'2026-03-29T23:00:00Z',end:'2026-03-30T01:00:00Z',breaks:0,note:'After spring day boundary',hours:'2.00'},
  {id:id(308),user:id(11),start:'2026-10-24T23:30:00Z',end:'2026-10-25T00:00:00Z',breaks:0,note:'Autumn first local half-hour',hours:'0.50'},
  {id:id(309),user:id(11),start:'2026-10-25T23:00:00Z',end:'2026-10-25T23:30:00Z',breaks:0,note:'Autumn last local hour',hours:'0.50'},
  {id:id(310),user:id(10),start:'2026-10-26T00:00:00Z',end:'2026-10-26T01:00:00Z',breaks:0,note:'After autumn day boundary',hours:'1.00'},
  {id:id(311),user:manager,start:'2026-10-22T08:00:00Z',end:'2026-10-22T12:00:00Z',breaks:0,note:'Manager own shift',hours:'4.00'},
  {id:id(312),user:id(20),start:'2026-10-24T09:00:00Z',end:'2026-10-24T17:00:00Z',breaks:0,note:'Other tenant secret',hours:'8.00'}
];
export async function seedManager(db) {
  await seedStaff(db);
  for (const [n,company,role,active,tester] of [[13,1,'admin',true,true],[14,1,'owner',true,true],[15,1,'admin',false,true],[16,1,'admin',true,false],[17,1,'staff',false,false],[23,2,'admin',true,true]]) {
    await db.query('insert into auth.users(id,email) values($1,$2)',[id(n),n+'@example.test']);
    await db.query('insert into staff(id,company_id,user_id,name,active) values($1,$2,$1,$3,$4)',[id(n),id(company),'Example person '+n,active]);
    await db.query('insert into attendance_staff_links(company_id,staff_id,attendance_user_id) values($1,$2,$2)',[id(company),id(n)]);
    await db.query('insert into aero_profiles(id,company_id,full_name,role,active) values($1,$2,$3,$4,$5)',[id(n),id(company),'Example person '+n,role,active]);
    if(tester) await db.query('insert into private.attendance_testers(company_id,user_id) values($1,$2)',[id(company),id(n)]);
  }
  await db.query('update aero_profiles set full_name=$1 where id=$2',['=Example, "Staff"\nA',id(10)]);
  await db.query('update aero_profiles set full_name=$1 where id=$2',['<b>Example staff 11</b>',id(11)]);
  await db.query('insert into aero_worksites(id,company_id,name,lat,lng) values($1,$2,$3,51.5,-0.1)',[id(103),id(1),'Remote "yard", B']);
  for(const s of cases) {
    await db.query('insert into aero_shifts(id,company_id,user_id,worksite_id,clock_in_at,clock_out_at,break_minutes,note) values($1,$2,$3,$4,$5,$6,$7,$8)',
      [s.id,s.user===id(20)?id(2):id(1),s.user,s.user===id(20)?id(102):s.user===id(11)?id(103):id(101),s.start,s.end,s.breaks,s.note]);
  }
  await db.query("insert into aero_shifts(id,company_id,user_id,worksite_id,clock_in_at,note) values($1,$2,$3,$4,now()-interval '2 hours','Running Example A'),($5,$2,$6,$7,now()-interval '14 hours','Running Example B')",
    [id(320),id(1),id(10),id(101),id(321),id(11),id(103)]);
  for(const [shift,user,start,end,reason] of [
    [id(301),id(10),'2026-10-24T20:00:00Z','2026-10-25T06:00:00Z','Example approval'],
    [id(302),id(11),'2026-10-25T00:20:00Z','2026-10-25T01:30:00Z','Example rejection'],
    [id(311),manager,'2026-10-22T07:00:00Z','2026-10-22T12:00:00Z','Example own request'],
    [id(312),id(20),'2026-10-24T08:00:00Z','2026-10-24T17:00:00Z','Other tenant correction']
  ]) await committed(db,user,'select aero_request_shift_correction($1,$2,$3,$4)',[shift,start,end,reason]);
}
