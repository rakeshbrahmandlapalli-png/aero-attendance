-- ════════════════════════════════════════════════════════════════════════
--  TEAM APP — staff attendance, multi-tenant
--
--  Run this ONCE in the Supabase SQL editor on a NEW project.
--  "Multi-tenant" means every client company lives in this one database,
--  fully walled off from each other. Company A can never read Company B's
--  staff, shifts or messages — that is enforced by the database itself
--  (Row Level Security), not by the website. If someone opened the browser
--  console and tried, Postgres would still refuse.
-- ════════════════════════════════════════════════════════════════════════

begin;

-- ── TABLES ──────────────────────────────────────────────────────────────

create table if not exists companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Where staff are allowed to clock in from. A company can have several
-- (247 has yards; A-Z has the shop counter).
create table if not exists worksites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null,
  lat         double precision not null,
  lng         double precision not null,
  -- How close you must be, in metres. 150m is a sane default: GPS on a
  -- phone is routinely 20-50m out, and a tight radius means honest staff
  -- get rejected standing in the right place, which kills trust in the app
  -- faster than any amount of clock-in fiddling.
  radius_m    integer not null default 150,
  created_at  timestamptz not null default now()
);

-- One row per person. id matches the Supabase auth user id.
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  full_name   text not null default '',
  role        text not null default 'staff' check (role in ('owner','admin','staff')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists profiles_company_idx on profiles(company_id);

-- One row per clock-in. clock_out_at null means "still on shift".
create table if not exists shifts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  user_id           uuid not null references profiles(id) on delete cascade,
  worksite_id       uuid references worksites(id) on delete set null,

  clock_in_at       timestamptz not null default now(),
  clock_in_lat      double precision,
  clock_in_lng      double precision,
  clock_in_metres   integer,          -- how far from the worksite they were
  clock_in_ok       boolean,          -- inside the radius?

  clock_out_at      timestamptz,
  clock_out_lat     double precision,
  clock_out_lng     double precision,
  clock_out_metres  integer,
  clock_out_ok      boolean,

  note              text not null default '',
  created_at        timestamptz not null default now()
);
create index if not exists shifts_company_idx on shifts(company_id, clock_in_at desc);
create index if not exists shifts_open_idx on shifts(user_id) where clock_out_at is null;


-- ── WHO AM I? ───────────────────────────────────────────────────────────
--
-- ⚠️ READ THIS BEFORE CHANGING ANY POLICY BELOW.
--
-- A policy ON a table that queries THAT SAME table is infinite recursion.
-- Postgres aborts with error 42P17 and every query fails. This exact bug
-- cost an evening on another project, and it presented as "you are not
-- allowed" rather than as a crash, which sent us hunting in the wrong place
-- for hours.
--
-- `security definer` is the fix: the function runs as its owner, so the
-- query inside it is NOT subject to RLS and cannot recurse. Every policy
-- calls these two functions instead of querying profiles directly.

create or replace function current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from profiles where id = auth.uid()
$$;

create or replace function is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('owner','admin') and active
  )
$$;


-- ── DISTANCE ────────────────────────────────────────────────────────────
--
-- Haversine, in metres. Deliberately a database function, not browser code:
-- the phone reports where it claims to be, but the DATABASE decides whether
-- that counts. Otherwise anyone could edit the JavaScript and mark their own
-- clock-in as on-site.
--
-- Be honest about what this does and doesn't stop: it stops someone clocking
-- in from bed. It does not stop a determined faker with a spoofing app on a
-- rooted phone. Sell it as an honesty check, not surveillance.

create or replace function metres_between(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable as $$
  select 6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    power(sin(radians(lng2 - lng1) / 2), 2)
  ))
$$;


-- ── CLOCK IN / OUT ──────────────────────────────────────────────────────
--
-- Done as functions rather than plain inserts so the rules live in one
-- place the browser cannot argue with: you cannot be on two shifts at once,
-- you cannot clock out of a shift that is not yours, and the distance check
-- is applied server-side every time.

create or replace function clock_in(
  p_worksite_id uuid,
  p_lat double precision default null,
  p_lng double precision default null
) returns shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := current_company_id();
  v_site    worksites;
  v_metres  double precision;
  v_ok      boolean;
  v_shift   shifts;
begin
  if v_company is null then
    raise exception 'No profile for this user — ask your manager to add you.';
  end if;

  -- Serialise simultaneous clock-ins for one person before checking the open shift.
  perform 1 from profiles where id = auth.uid() and active for update;
  if not found then raise exception 'Your account is inactive.'; end if;

  -- Already on shift? Hand back the open one rather than opening a second.
  -- A double tap on a slow connection must not create two shifts.
  select * into v_shift from shifts
   where user_id = auth.uid() and clock_out_at is null
   order by clock_in_at desc limit 1;
  if found then
    return v_shift;
  end if;

  select * into v_site from worksites
   where id = p_worksite_id and company_id = v_company;
  if not found then
    raise exception 'Unknown worksite.';
  end if;

  if p_lat is not null and p_lng is not null then
    v_metres := metres_between(p_lat, p_lng, v_site.lat, v_site.lng);
    v_ok := v_metres <= v_site.radius_m;
  else
    -- No location given (permission denied, or indoors with no fix). Record
    -- it honestly as unverified rather than refusing — a refused clock-in
    -- means an unpaid shift, and that is a far worse failure than a flagged
    -- one a manager can check.
    v_metres := null;
    v_ok := null;
  end if;

  insert into shifts (company_id, user_id, worksite_id,
                      clock_in_lat, clock_in_lng, clock_in_metres, clock_in_ok)
  values (v_company, auth.uid(), p_worksite_id,
          p_lat, p_lng, round(v_metres)::int, v_ok)
  returning * into v_shift;

  return v_shift;
end;
$$;

create or replace function clock_out(
  p_lat double precision default null,
  p_lng double precision default null,
  p_note text default ''
) returns shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_site   worksites;
  v_metres double precision;
  v_ok     boolean;
  v_shift  shifts;
begin
  select * into v_shift from shifts
   where user_id = auth.uid() and clock_out_at is null
   order by clock_in_at desc limit 1;
  if not found then
    raise exception 'You are not clocked in.';
  end if;

  if v_shift.worksite_id is not null and p_lat is not null and p_lng is not null then
    select * into v_site from worksites where id = v_shift.worksite_id;
    if found then
      v_metres := metres_between(p_lat, p_lng, v_site.lat, v_site.lng);
      v_ok := v_metres <= v_site.radius_m;
    end if;
  end if;

  update shifts set
    clock_out_at     = now(),
    clock_out_lat    = p_lat,
    clock_out_lng    = p_lng,
    clock_out_metres = round(v_metres)::int,
    clock_out_ok     = v_ok,
    note             = coalesce(nullif(p_note, ''), note)
  where id = v_shift.id
  returning * into v_shift;

  return v_shift;
end;
$$;


-- ── ROW LEVEL SECURITY ──────────────────────────────────────────────────
-- Nothing is readable until a policy says so. Every policy is scoped to the
-- caller's own company.

alter table companies enable row level security;
alter table worksites enable row level security;
alter table profiles  enable row level security;
alter table shifts    enable row level security;

-- Companies: you can see your own, only an owner/admin can rename it.
drop policy if exists companies_read on companies;
create policy companies_read on companies for select to authenticated
  using (id = current_company_id());

drop policy if exists companies_update on companies;
create policy companies_update on companies for update to authenticated
  using (id = current_company_id() and is_manager());

-- Worksites: everyone in the company can see them (the app needs the list
-- to clock in against); only managers can change them.
drop policy if exists worksites_read on worksites;
create policy worksites_read on worksites for select to authenticated
  using (company_id = current_company_id());

drop policy if exists worksites_write on worksites;
create policy worksites_write on worksites for all to authenticated
  using (company_id = current_company_id() and is_manager())
  with check (company_id = current_company_id() and is_manager());

-- Profiles: everyone sees their colleagues (needed to show names on the
-- board); only managers can add, edit or deactivate people.
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated
  using (company_id = current_company_id());

drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and company_id = current_company_id());

drop policy if exists profiles_manage on profiles;
create policy profiles_manage on profiles for all to authenticated
  using (company_id = current_company_id() and is_manager())
  with check (company_id = current_company_id() and is_manager());

-- Shifts: you always see your own. Managers see the whole company's.
-- Writes go through clock_in()/clock_out(), but a manager can correct a
-- row by hand — people forget to clock out and that has to be fixable.
drop policy if exists shifts_read on shifts;
create policy shifts_read on shifts for select to authenticated
  using (company_id = current_company_id()
         and (user_id = auth.uid() or is_manager()));

drop policy if exists shifts_manage on shifts;
create policy shifts_manage on shifts for all to authenticated
  using (company_id = current_company_id() and is_manager())
  with check (company_id = current_company_id() and is_manager());


-- ── LIVE BOARD ──────────────────────────────────────────────────────────
-- Who is on shift right now, as the admin screen draws it.
-- security_invoker is essential: without it a view runs as its owner and
-- ignores RLS, so anyone with the public key could read every company's
-- on-shift staff. With it, the shifts/profiles policies above apply.
create or replace view on_shift_now with (security_invoker = true) as
  select s.id           as shift_id,
         s.company_id,
         s.user_id,
         p.full_name,
         w.name         as worksite,
         s.clock_in_at,
         s.clock_in_ok,
         s.clock_in_metres,
         extract(epoch from (now() - s.clock_in_at))/3600 as hours_so_far
    from shifts s
    join profiles p  on p.id = s.user_id
    left join worksites w on w.id = s.worksite_id
   where s.clock_out_at is null;


-- ── ACCESS ──────────────────────────────────────────────────────────────
-- Signed-out visitors (anon) get nothing. Signed-in users get table access,
-- and RLS then limits them to their own company. Set explicitly rather than
-- relying on Supabase's defaults, which differ between projects.
revoke all on table companies, worksites, profiles, shifts, on_shift_now from anon;
grant select, insert, update, delete on table companies, worksites, profiles, shifts to authenticated;
grant select on table on_shift_now to authenticated;

revoke execute on function clock_in(uuid, double precision, double precision) from public, anon;
revoke execute on function clock_out(double precision, double precision, text) from public, anon;
grant execute on function clock_in(uuid, double precision, double precision) to authenticated;
grant execute on function clock_out(double precision, double precision, text) to authenticated;

-- Attendance corrections: originals and decisions remain available for review.
create table if not exists shift_corrections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  shift_id uuid not null references shifts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  original_in timestamptz not null,
  original_out timestamptz,
  requested_in timestamptz not null,
  requested_out timestamptz not null,
  reason text not null check (length(trim(reason)) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_note text not null default '',
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (requested_out > requested_in)
);
create unique index if not exists corrections_one_pending on shift_corrections(shift_id) where status = 'pending';
create index if not exists corrections_company_date on shift_corrections(company_id, created_at desc);
alter table shift_corrections enable row level security;
drop policy if exists corrections_read on shift_corrections;
create policy corrections_read on shift_corrections for select to authenticated
  using (company_id = current_company_id() and (user_id = auth.uid() or is_manager()));
revoke all on shift_corrections from anon, authenticated;
grant select on shift_corrections to authenticated;

-- Staff cannot change their own company, role or active status.
drop policy if exists profiles_self_update on profiles;

create or replace function request_shift_correction(
  p_shift_id uuid, p_in timestamptz, p_out timestamptz, p_reason text
) returns shift_corrections
language plpgsql security definer set search_path = public as $$
declare v_shift shifts; v_request shift_corrections;
begin
  if not exists (select 1 from profiles where id = auth.uid() and active) then
    raise exception 'Your account is inactive.';
  end if;
  select * into v_shift from shifts where id = p_shift_id
    and user_id = auth.uid() and company_id = current_company_id() for update;
  if not found then raise exception 'Shift not found.'; end if;
  if p_in is null or p_out is null or not isfinite(p_in) or not isfinite(p_out)
     or p_out <= p_in or p_out > now() then
    raise exception 'Enter a start and end time in the past, with the end after the start.';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 1 and 1000 then
    raise exception 'Enter a reason of up to 1000 characters.';
  end if;
  if p_in = v_shift.clock_in_at and p_out is not distinct from v_shift.clock_out_at then
    raise exception 'The requested times are unchanged.';
  end if;
  if exists (select 1 from shift_corrections where shift_id = p_shift_id and status = 'pending') then
    raise exception 'This shift already has a pending correction.';
  end if;
  insert into shift_corrections(company_id, shift_id, user_id, original_in, original_out,
      requested_in, requested_out, reason)
    values (v_shift.company_id, v_shift.id, auth.uid(), v_shift.clock_in_at,
      v_shift.clock_out_at, p_in, p_out, trim(p_reason)) returning * into v_request;
  return v_request;
end;
$$;

create or replace function review_shift_correction(p_id uuid, p_approve boolean, p_note text default '')
returns shift_corrections
language plpgsql security definer set search_path = public as $$
declare v_request shift_corrections; v_shift shifts;
begin
  if not coalesce(is_manager(), false) then raise exception 'Manager access required.'; end if;
  if p_approve is null then raise exception 'Choose approve or reject.'; end if;
  if length(coalesce(p_note, '')) > 1000 then raise exception 'Review note is too long.'; end if;
  select * into v_request from shift_corrections where id = p_id
    and company_id = current_company_id() for update;
  if not found then raise exception 'Correction not found.'; end if;
  if v_request.user_id = auth.uid() then raise exception 'Another manager must review your own correction.'; end if;
  if v_request.status <> 'pending' then raise exception 'This correction has already been reviewed.'; end if;
  if p_approve then
    select * into v_shift from shifts where id = v_request.shift_id for update;
    if v_shift.clock_in_at is distinct from v_request.original_in
       or v_shift.clock_out_at is distinct from v_request.original_out then
      raise exception 'This shift has changed since the request. Reject it and ask for a new request.';
    end if;
    if exists (select 1 from shifts where user_id = v_request.user_id and id <> v_shift.id
      and clock_in_at < v_request.requested_out
      and coalesce(clock_out_at, 'infinity'::timestamptz) > v_request.requested_in) then
      raise exception 'These times overlap another shift.';
    end if;
    update shifts set clock_in_at = v_request.requested_in, clock_out_at = v_request.requested_out
      where id = v_request.shift_id;
  end if;
  update shift_corrections set status = case when p_approve then 'approved' else 'rejected' end,
    review_note = trim(coalesce(p_note, '')), reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_id returning * into v_request;
  return v_request;
end;
$$;
revoke execute on function request_shift_correction(uuid,timestamptz,timestamptz,text) from public, anon;
revoke execute on function review_shift_correction(uuid,boolean,text) from public, anon;
grant execute on function request_shift_correction(uuid,timestamptz,timestamptz,text) to authenticated;
grant execute on function review_shift_correction(uuid,boolean,text) to authenticated;

-- ── ESTIMATED PAY (optional, off by default) ─────────────────────────────
-- One hourly rate per person. Rates live in their own table because every
-- colleague can read profiles. Staff can read their own rate only once their
-- company has switched pay on; managers read and set rates for their own
-- company only. Safe to run again.
alter table companies add column if not exists show_pay boolean not null default false;

create table if not exists pay_rates (
  user_id     uuid primary key references profiles(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  hourly_rate numeric(8,2) not null check (hourly_rate >= 0 and hourly_rate <= 1000),
  updated_at  timestamptz not null default now()
);
create index if not exists pay_rates_company_idx on pay_rates(company_id);
alter table pay_rates enable row level security;

drop policy if exists pay_rates_read on pay_rates;
create policy pay_rates_read on pay_rates for select to authenticated
  using (pay_rates.company_id = current_company_id()
         and (is_manager()
              or (pay_rates.user_id = auth.uid()
                  and exists (select 1 from companies c
                              where c.id = pay_rates.company_id and c.show_pay))));

drop policy if exists pay_rates_manage on pay_rates;
create policy pay_rates_manage on pay_rates for all to authenticated
  using (pay_rates.company_id = current_company_id() and is_manager())
  with check (pay_rates.company_id = current_company_id() and is_manager()
              and exists (select 1 from profiles p
                          where p.id = pay_rates.user_id and p.company_id = pay_rates.company_id));

revoke all on table pay_rates from anon;
grant select, insert, update, delete on table pay_rates to authenticated;

-- Managers may change only a company's name and its pay switch.
revoke update on table companies from authenticated;
grant update (name, show_pay) on table companies to authenticated;

commit;
