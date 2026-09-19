-- Aero Attendance — staff profiles, clearing alerts, and notice notifications (September 2026)
--
-- Run update-2026-09-audit.sql and update-2026-09-add-ons.sql first.
--
-- Four things, in one file so there is one thing to run:
--
--   1. JOB ROLES. A list each company keeps (Driver, Valet, Supervisor...) and a
--      job_role_id on each person. This is a LABEL. It is not the same as a
--      person's access (owner / manager / staff), which decides what they may do
--      and is left exactly as it was.
--
--   2. STAFF DETAILS. Date of birth, phone, emergency contact, start date. These
--      are deliberately NOT columns on profiles: every colleague can read profiles
--      (the app shows names), so a date of birth there would be readable by the
--      whole team. They live in their own table that only managers, and the person
--      themselves, can read. Only save_staff_details() writes it, and it records
--      THAT a manager changed somebody's details in the audit history but never
--      WHAT the details were.
--
--   3. CLEARING ALERTS. A manager can clear a flag on the Now board. It is shared
--      across the company's managers and recorded in the audit history.
--
--   4. NOTICE NOTIFICATIONS. Posting a notice now asks send-push to tell everyone
--      in the company.
--
-- 1 and 2 are one add-on, "staff_profiles", which the owner switches per client on
-- /platform. The database refuses them when it is off, not just the page.
--
-- Safe to run more than once. Already folded into setup/schema.sql.

begin;

-- ── the add-on switch ────────────────────────────────────────────────────
alter table company_features drop constraint if exists company_features_feature_check;
alter table company_features add constraint company_features_feature_check
  check (feature in ('rota','pay','breaks','notices','handover','overtime','incidents','staff_profiles'));

-- ── 1. JOB ROLES ─────────────────────────────────────────────────────────
create table if not exists job_roles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 40),
  created_at  timestamptz not null default now()
);
create unique index if not exists job_roles_company_name on job_roles (company_id, lower(btrim(name)));
alter table job_roles enable row level security;

drop policy if exists job_roles_read on job_roles;
create policy job_roles_read on job_roles for select to authenticated
  using (company_id = current_company_id() and has_feature('staff_profiles'));

drop policy if exists job_roles_manage on job_roles;
create policy job_roles_manage on job_roles for all to authenticated
  using (company_id = current_company_id() and is_manager() and has_feature('staff_profiles'))
  with check (company_id = current_company_id() and is_manager() and has_feature('staff_profiles'));

revoke all on table job_roles from anon;
grant select, insert, update, delete on table job_roles to authenticated;

-- Removing a role from the list leaves the person with no job role, nothing more.
alter table profiles add column if not exists job_role_id uuid references job_roles(id) on delete set null;

-- A manager writes profiles from the browser, so nothing else stops them pointing a
-- person at ANOTHER company's role id. No data would leak, but it is a dangling
-- reference across a wall that is meant to be solid.
create or replace function profiles_job_role_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.job_role_id is not null
     and not exists (select 1 from job_roles j where j.id = new.job_role_id and j.company_id = new.company_id) then
    raise exception 'That job role is not one of yours.';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_job_role_guard on profiles;
create trigger profiles_job_role_guard
  before insert or update of job_role_id on profiles
  for each row when (new.job_role_id is not null)
  execute function profiles_job_role_guard();

-- ── 2. STAFF DETAILS ─────────────────────────────────────────────────────
create table if not exists staff_details (
  user_id          uuid primary key references profiles(id) on delete cascade,
  company_id       uuid not null references companies(id) on delete cascade,
  date_of_birth    date check (date_of_birth is null or date_of_birth > date '1900-01-01'),
  phone            text check (phone is null or length(phone) <= 30),
  emergency_name   text check (emergency_name is null or length(emergency_name) <= 100),
  emergency_phone  text check (emergency_phone is null or length(emergency_phone) <= 30),
  start_date       date check (start_date is null or start_date > date '1900-01-01'),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references profiles(id) on delete set null
);
create index if not exists staff_details_company_idx on staff_details(company_id);
alter table staff_details enable row level security;

drop policy if exists staff_details_read on staff_details;
create policy staff_details_read on staff_details for select to authenticated
  using (company_id = current_company_id() and has_feature('staff_profiles')
         and (is_manager() or user_id = auth.uid()));

-- No insert, update or delete grant: save_staff_details() is the only way in.
revoke all on table staff_details from anon, authenticated;
grant select on table staff_details to authenticated;

create or replace function save_staff_details(
  p_user_id uuid, p_dob date, p_phone text, p_emergency_name text, p_emergency_phone text, p_start date
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := current_company_id();
  v_who     text;
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_en      text := nullif(btrim(coalesce(p_emergency_name, '')), '');
  v_ep      text := nullif(btrim(coalesce(p_emergency_phone, '')), '');
begin
  if not coalesce(is_manager(), false) then raise exception 'Manager access required.'; end if;
  if not coalesce(has_feature('staff_profiles'), false) then
    raise exception 'Staff profiles are not part of this company''s plan.';
  end if;
  select full_name into v_who from profiles where id = p_user_id and company_id = v_company;
  if not found then raise exception 'That person is not one of yours.'; end if;

  if p_dob is not null and (p_dob >= current_date or p_dob <= date '1900-01-01') then
    raise exception 'Check the date of birth.';
  end if;
  if p_start is not null and p_start <= date '1900-01-01' then raise exception 'Check the start date.'; end if;
  if length(coalesce(v_phone, '')) > 30 or length(coalesce(v_ep, '')) > 30 then
    raise exception 'A phone number can be up to 30 characters.';
  end if;
  if length(coalesce(v_en, '')) > 100 then raise exception 'The emergency contact name can be up to 100 characters.'; end if;

  if p_dob is null and v_phone is null and v_en is null and v_ep is null and p_start is null then
    delete from staff_details where user_id = p_user_id;      -- nothing recorded: keep nothing
  else
    insert into staff_details (user_id, company_id, date_of_birth, phone, emergency_name, emergency_phone, start_date, updated_by)
    values (p_user_id, v_company, p_dob, v_phone, v_en, v_ep, p_start, auth.uid())
    on conflict (user_id) do update
       set date_of_birth = excluded.date_of_birth, phone = excluded.phone,
           emergency_name = excluded.emergency_name, emergency_phone = excluded.emergency_phone,
           start_date = excluded.start_date, updated_at = now(), updated_by = excluded.updated_by;
  end if;

  -- That it happened, never what the details were.
  perform write_audit_event(v_company, auth.uid(), 'updated', 'staff_profile', p_user_id,
    'Manager updated ' || coalesce(v_who, 'a member of staff') || '''s personal details.', '{}'::jsonb);
end;
$$;
revoke execute on function save_staff_details(uuid, date, text, text, text, date) from public, anon;
grant execute on function save_staff_details(uuid, date, text, text, text, date) to authenticated;

-- ── 3. CLEARING ALERTS ───────────────────────────────────────────────────
-- An alert is worked out from live data every time, so it goes away by itself once
-- the thing it is about is fixed. Clearing is for "I know, and it is fine", and it
-- is shared: what one manager clears, the others stop seeing.
create table if not exists dismissed_alerts (
  company_id    uuid not null references companies(id) on delete cascade,
  alert_key     text not null check (length(alert_key) between 1 and 120),
  dismissed_by  uuid references profiles(id) on delete set null,
  dismissed_at  timestamptz not null default now(),
  primary key (company_id, alert_key)
);
alter table dismissed_alerts enable row level security;

drop policy if exists dismissed_alerts_read on dismissed_alerts;
create policy dismissed_alerts_read on dismissed_alerts for select to authenticated
  using (company_id = current_company_id() and is_manager());

revoke all on table dismissed_alerts from anon, authenticated;
grant select on table dismissed_alerts to authenticated;

create or replace function dismiss_alert(p_key text, p_summary text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_company uuid := current_company_id(); v_key text := btrim(coalesce(p_key, '')); v_n integer;
begin
  if not coalesce(is_manager(), false) then raise exception 'Manager access required.'; end if;
  if length(v_key) not between 1 and 120 then raise exception 'Nothing to clear.'; end if;
  -- An alert is about a shift or a rota slot, and a week on it is long over.
  delete from dismissed_alerts where company_id = v_company and dismissed_at < now() - interval '7 days';
  insert into dismissed_alerts (company_id, alert_key, dismissed_by)
    values (v_company, v_key, auth.uid()) on conflict do nothing;
  get diagnostics v_n = row_count;
  -- Tapping Clear twice must not log it twice.
  if v_n = 0 then return; end if;
  perform write_audit_event(v_company, auth.uid(), 'cleared', 'alert', null,
    left('Manager cleared an alert: ' || coalesce(nullif(btrim(coalesce(p_summary, '')), ''), v_key), 500),
    jsonb_build_object('key', v_key));
end;
$$;
revoke execute on function dismiss_alert(text, text) from public, anon;
grant execute on function dismiss_alert(text, text) to authenticated;

-- ── 4. NOTICE NOTIFICATIONS ──────────────────────────────────────────────
alter table notification_prefs add column if not exists notices boolean not null default true;

create or replace function announcements_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform push_event(jsonb_build_object('type', 'notice', 'id', new.id));
  return null;
end;
$$;
drop trigger if exists announcements_push on announcements;
create trigger announcements_push
  after insert on announcements
  for each row when (new.active)
  execute function announcements_push();

commit;
