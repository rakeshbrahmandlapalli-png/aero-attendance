// Synthetic in-memory PostgreSQL only. Auth, cron and HTTP are harness stubs.
import {boot} from './harness.mjs';
import {readParking, verifySharedCheckouts} from './shared-checkout.mjs';

export const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
export async function bootShared() {
  verifySharedCheckouts();
  const db = await boot();
  try {
    await db.exec(`create schema private;
alter table companies add column slug text,add column brand jsonb default '{}',add column suspended_at timestamptz,add column yards text[],add column drops_day_end time default '06:00';
create table staff(id uuid primary key,company_id uuid references companies(id),user_id uuid,name text,active boolean default true,removed_at timestamptz,desk_names text[] default '{}');
create table activity(company_id uuid,staff_name text,action text,value text);
create function me() returns staff language sql security definer set search_path=public as $$select * from staff where user_id=auth.uid()$$;
create function is_platform_admin() returns boolean language sql as $$select false$$;`);
    for (const name of ['130-attendance-addon.sql', '131-attendance-identity.sql', '132-attendance-pilot.sql']) {
      await db.exec(readParking('setup/' + name));
    }
    const shared = readParking('setup/134-attendance-shared.sql').replace(/^\s*create extension[^;]*;/gim, '-- Harness provides extensions');
    await db.exec(shared);
    await db.exec(shared);
    return db;
  } catch (error) { await db.close(); throw error; }
}

export async function seedStaff(db) {
  for (const company of [1, 2]) {
    await db.query(`insert into companies(id,name,brand) values($1,$2,'{"attendance":true}');`, [id(company), 'Example company ' + company]);
    await db.query('insert into aero_companies(id,name,require_on_site,use_breaks) values($1,$2,false,true)', [id(company), 'Example company ' + company]);
    await db.query("insert into aero_worksites(id,company_id,name,lat,lng) values($1,$2,'Example yard',51.5,-0.1)", [id(100 + company), id(company)]);
    for (const offset of [0, 1, 2]) {
      const user = id(company * 10 + offset);
      await db.query('insert into auth.users(id,email) values($1,$2)', [user, user + '@example.test']);
      await db.query('insert into staff(id,company_id,user_id,name) values($1,$2,$1,$3)', [user, id(company), 'Example person ' + (company * 10 + offset)]);
      await db.query('insert into attendance_staff_links(company_id,staff_id,attendance_user_id) values($1,$2,$2)', [id(company), user]);
      await db.query("insert into aero_profiles(id,company_id,full_name,role) values($1,$2,$3,'staff')", [user, id(company), 'Example person ' + (company * 10 + offset)]);
      if (offset < 2) await db.query('insert into private.attendance_testers(company_id,user_id) values($1,$2)', [id(company), user]);
    }
  }
}

export async function committed(db, user, sql, args = []) {
  return db.transaction(async tx => {
    await tx.exec('set local role ' + (user === 'anon' ? 'anon' : 'authenticated'));
    if (user !== 'anon') await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    return (await tx.query(sql, args)).rows;
  });
}
