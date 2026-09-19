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

-- ── ROTA & AVAILABILITY (optional, off by default) ─────────────────────
-- A company switches this on in Company settings. Staff keep a usual week
-- and book days off; managers draft shifts and publish a week when it's
-- ready. Staff only ever see the PUBLISHED copy of a shift (published_*
-- columns), so a manager can rework a week without staff watching it change.
-- Safe to run again.
alter table companies add column if not exists use_rota boolean not null default false;
revoke update on table companies from authenticated;
grant update (name, show_pay, use_rota) on table companies to authenticated;

-- A person's usual week: one row per weekday (0 = Monday … 6 = Sunday).
create table if not exists availability (
  user_id     uuid not null references profiles(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  kind        text not null check (kind in ('any','between','off')),
  start_time  time,
  end_time    time,
  updated_at  timestamptz not null default now(),
  primary key (user_id, weekday),
  check (kind <> 'between' or (start_time is not null and end_time is not null and start_time <> end_time))
);
alter table availability enable row level security;

drop policy if exists availability_read on availability;
create policy availability_read on availability for select to authenticated
  using (company_id = current_company_id() and (user_id = auth.uid() or is_manager()));

drop policy if exists availability_own on availability;
create policy availability_own on availability for all to authenticated
  using (company_id = current_company_id() and user_id = auth.uid())
  with check (company_id = current_company_id() and user_id = auth.uid());

-- Days a person can't work (holiday, appointments). Staff add and remove
-- their own; managers only read them while planning.
create table if not exists time_off (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  first_day   date not null,
  last_day    date not null,
  reason      text not null default '' check (length(reason) <= 200),
  created_at  timestamptz not null default now(),
  check (last_day >= first_day and last_day - first_day <= 60)
);
create index if not exists time_off_company_idx on time_off(company_id, first_day);
alter table time_off enable row level security;

drop policy if exists time_off_read on time_off;
create policy time_off_read on time_off for select to authenticated
  using (company_id = current_company_id() and (user_id = auth.uid() or is_manager()));

drop policy if exists time_off_add on time_off;
create policy time_off_add on time_off for insert to authenticated
  with check (company_id = current_company_id() and user_id = auth.uid());

drop policy if exists time_off_remove on time_off;
create policy time_off_remove on time_off for delete to authenticated
  using (company_id = current_company_id() and user_id = auth.uid());

-- Planned shifts. starts_at/ends_at/worksite_id/note are the manager's
-- draft; published_* is what staff see, copied across by publish_rota().
-- A published shift the manager deletes is marked removed, so staff keep
-- seeing it until the week is published again.
create table if not exists rota_shifts (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references companies(id) on delete cascade,
  user_id                uuid not null references profiles(id) on delete cascade,
  worksite_id            uuid references worksites(id) on delete set null,
  starts_at              timestamptz not null,
  ends_at                timestamptz not null,
  note                   text not null default '' check (length(note) <= 300),
  published_starts_at    timestamptz,
  published_ends_at      timestamptz,
  published_worksite_id  uuid references worksites(id) on delete set null,
  published_note         text,
  removed                boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '16 hours')
);
create index if not exists rota_company_idx on rota_shifts(company_id, starts_at);
create index if not exists rota_user_idx on rota_shifts(user_id, published_starts_at);
alter table rota_shifts enable row level security;

drop policy if exists rota_read on rota_shifts;
create policy rota_read on rota_shifts for select to authenticated
  using (company_id = current_company_id()
         and (is_manager() or (user_id = auth.uid() and published_starts_at is not null)));

drop policy if exists rota_manage on rota_shifts;
create policy rota_manage on rota_shifts for all to authenticated
  using (company_id = current_company_id() and is_manager())
  with check (company_id = current_company_id() and is_manager()
              and exists (select 1 from profiles p
                          where p.id = rota_shifts.user_id and p.company_id = rota_shifts.company_id)
              and (rota_shifts.worksite_id is null
                   or exists (select 1 from worksites w
                              where w.id = rota_shifts.worksite_id and w.company_id = rota_shifts.company_id)));

revoke all on table availability, time_off, rota_shifts from anon;
grant select, insert, update, delete on table availability, time_off, rota_shifts to authenticated;

-- Publish one week (or any range up to a month) for the caller's company:
-- drops shifts removed in the draft and copies every draft onto what staff
-- see. Returns how many shifts changed.
create or replace function publish_rota(p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid := current_company_id();
  v_removed integer;
  v_updated integer;
begin
  if not coalesce(is_manager(), false) then raise exception 'Manager access required.'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '32 days' then
    raise exception 'Choose a week to publish.';
  end if;

  delete from rota_shifts
   where company_id = v_company and removed
     and coalesce(published_starts_at, starts_at) >= p_from
     and coalesce(published_starts_at, starts_at) < p_to;
  get diagnostics v_removed = row_count;

  update rota_shifts set
    published_starts_at   = starts_at,
    published_ends_at     = ends_at,
    published_worksite_id = worksite_id,
    published_note        = note,
    updated_at            = now()
   where company_id = v_company and not removed
     and starts_at >= p_from and starts_at < p_to
     and (published_starts_at is distinct from starts_at
          or published_ends_at is distinct from ends_at
          or published_worksite_id is distinct from worksite_id
          or published_note is distinct from note);
  get diagnostics v_updated = row_count;

  return v_removed + v_updated;
end;
$$;
revoke execute on function publish_rota(timestamptz, timestamptz) from public, anon;
grant execute on function publish_rota(timestamptz, timestamptz) to authenticated;


-- ── ANNOUNCEMENTS ───────────────────────────────────────────────────────
-- A manager writes a short message; everyone in that company sees it on Home
-- until they dismiss it. Dismissing records that the person read it, so the
-- manager can see who has not.
create table if not exists announcements (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  author_id   uuid references profiles(id) on delete set null,
  body        text not null check (length(btrim(body)) between 1 and 500),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  active      boolean not null default true
);
create index if not exists announcements_company_idx on announcements(company_id, created_at desc);
alter table announcements enable row level security;

-- Staff see live ones only. Managers see every one, so they can reopen or
-- switch off something they posted earlier.
drop policy if exists announcements_read on announcements;
create policy announcements_read on announcements for select to authenticated
  using (company_id = current_company_id()
         and (is_manager()
              or (active and (expires_at is null or expires_at > now()))));

drop policy if exists announcements_manage on announcements;
create policy announcements_manage on announcements for all to authenticated
  using (company_id = current_company_id() and is_manager())
  with check (company_id = current_company_id() and is_manager()
              and (author_id is null
                   or exists (select 1 from profiles p
                              where p.id = announcements.author_id
                                and p.company_id = announcements.company_id)));

-- Who has seen what. A read is a fact: it can be written once and never
-- edited or withdrawn, so there is no update or delete grant below.
create table if not exists announcement_reads (
  announcement_id uuid not null references announcements(id) on delete cascade,
  user_id         uuid not null references profiles(id) on delete cascade,
  company_id      uuid not null references companies(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
alter table announcement_reads enable row level security;

drop policy if exists announcement_reads_read on announcement_reads;
create policy announcement_reads_read on announcement_reads for select to authenticated
  using (company_id = current_company_id() and (user_id = auth.uid() or is_manager()));

drop policy if exists announcement_reads_own on announcement_reads;
create policy announcement_reads_own on announcement_reads for insert to authenticated
  with check (company_id = current_company_id() and user_id = auth.uid()
              and exists (select 1 from announcements a
                          where a.id = announcement_reads.announcement_id
                            and a.company_id = announcement_reads.company_id));

revoke all on table announcements, announcement_reads from anon;
grant select, insert, update, delete on table announcements to authenticated;
grant select, insert on table announcement_reads to authenticated;


-- ── LEAVERS LOSE ACCESS ─────────────────────────────────────────────────
-- A removed (inactive) person belongs to no company as far as the policies
-- are concerned, so a session they still have open shows nothing. Managers
-- remove people through the manage-staff Edge Function, which also blocks
-- their sign-in. Still security definer: see WHO AM I? in schema.sql.
create or replace function current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from profiles where id = auth.uid() and active
$$;

-- Update for September 2026: phone notifications (web push).
-- Run it once in the Supabase SQL editor, after the rota update. Safe to run again.
--
-- How it fits together:
--   * Each phone that taps "Turn on notifications" saves a push_subscriptions row.
--   * notification_prefs holds what each person wants (missing row = everything on).
--   * Triggers on shifts, shift_corrections and publish_rota() queue a small
--     {type, id} message to the send-push Edge Function through pg_net, and a
--     pg_cron job sends {type: "tick"} every 5 minutes for late starts,
--     no-shows, long shifts and shift reminders.
--   * The Edge Function re-reads everything itself with the service key and
--     records each notification in push_log, so a message can only ever cause
--     the one notification that was due anyway. That is why the call needs no
--     secret, and why a failed call can never block a clock-in.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- One row: where the send-push function lives. Change the address here if
-- Supabase gives the function a different one.
create table if not exists push_config (
  id            boolean primary key default true check (id),
  function_url  text not null
);
alter table push_config enable row level security;          -- no policies: database only
revoke all on table push_config from anon, authenticated;
insert into push_config (function_url)
  values ('https://ljrzcrphuepqtfrayeid.supabase.co/functions/v1/send-push')
  on conflict (id) do nothing;

-- A phone (or browser) that has allowed notifications.
create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions(user_id);
alter table push_subscriptions enable row level security;
drop policy if exists push_subscriptions_own on push_subscriptions;
create policy push_subscriptions_own on push_subscriptions for select to authenticated
  using (user_id = auth.uid());

-- What each person wants. Everything defaults to on.
create table if not exists notification_prefs (
  user_id               uuid primary key references profiles(id) on delete cascade,
  company_id            uuid not null references companies(id) on delete cascade,
  clock_in              boolean not null default true,
  clock_out             boolean not null default true,
  away                  boolean not null default true,
  corrections           boolean not null default true,
  late                  boolean not null default true,
  long_shift            boolean not null default true,
  correction_decisions  boolean not null default true,
  rota                  boolean not null default true,
  reminders             boolean not null default true,
  updated_at            timestamptz not null default now()
);
alter table notification_prefs enable row level security;
drop policy if exists notification_prefs_own on notification_prefs;
create policy notification_prefs_own on notification_prefs for all to authenticated
  using (user_id = auth.uid() and company_id = current_company_id())
  with check (user_id = auth.uid() and company_id = current_company_id());

-- Every notification sent, so none is ever sent twice.
create table if not exists push_log (
  key      text primary key,
  sent_at  timestamptz not null default now()
);
alter table push_log enable row level security;             -- no policies: function only
revoke all on table push_log from anon, authenticated;

revoke all on table push_subscriptions, notification_prefs from anon;
revoke all on table push_subscriptions from authenticated;
grant select on table push_subscriptions to authenticated;
grant select, insert, update, delete on table notification_prefs to authenticated;

-- Save this phone for the signed-in person. If someone else used the same
-- phone before, it moves to the new person, so notifications follow whoever
-- is signed in.
create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_company uuid := current_company_id();
begin
  if v_company is null then raise exception 'Your account is inactive.'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000
     or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'This phone did not give a valid notification address.';
  end if;
  insert into push_subscriptions (user_id, company_id, endpoint, p256dh, auth)
    values (auth.uid(), v_company, p_endpoint, p_p256dh, p_auth)
    on conflict (endpoint) do update
      set user_id = excluded.user_id, company_id = excluded.company_id,
          p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end;
$$;

create or replace function remove_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke execute on function save_push_subscription(text, text, text) from public, anon;
revoke execute on function remove_push_subscription(text) from public, anon;
grant execute on function save_push_subscription(text, text, text) to authenticated;
grant execute on function remove_push_subscription(text) to authenticated;

-- Queue a message for the send-push function. Never raises: a notification
-- must not be able to stop a clock-in or a publish.
create or replace function push_event(p_body jsonb)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text;
begin
  select function_url into v_url from push_config;
  if v_url is null then return; end if;
  perform net.http_post(
    url := v_url,
    body := p_body,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 10000
  );
exception when others then
  raise warning 'push_event skipped: %', sqlerrm;
end;
$$;
revoke execute on function push_event(jsonb) from public, anon, authenticated;

create or replace function shifts_push()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or (old.clock_out_at is null and new.clock_out_at is not null) then
    perform push_event(jsonb_build_object('type', 'shift', 'id', new.id));
  end if;
  return null;
end;
$$;
drop trigger if exists shifts_push on shifts;
create trigger shifts_push after insert or update of clock_out_at on shifts
  for each row execute function shifts_push();

create or replace function corrections_push()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    perform push_event(jsonb_build_object('type', 'correction', 'id', new.id));
  end if;
  return null;
end;
$$;
drop trigger if exists corrections_push on shift_corrections;
create trigger corrections_push after insert or update of status on shift_corrections
  for each row execute function corrections_push();

-- publish_rota, as in the rota update, now also tells staff their rota is out.
create or replace function publish_rota(p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid := current_company_id();
  v_removed integer;
  v_updated integer;
begin
  if not coalesce(is_manager(), false) then raise exception 'Manager access required.'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '32 days' then
    raise exception 'Choose a week to publish.';
  end if;

  delete from rota_shifts
   where company_id = v_company and removed
     and coalesce(published_starts_at, starts_at) >= p_from
     and coalesce(published_starts_at, starts_at) < p_to;
  get diagnostics v_removed = row_count;

  update rota_shifts set
    published_starts_at   = starts_at,
    published_ends_at     = ends_at,
    published_worksite_id = worksite_id,
    published_note        = note,
    updated_at            = now()
   where company_id = v_company and not removed
     and starts_at >= p_from and starts_at < p_to
     and (published_starts_at is distinct from starts_at
          or published_ends_at is distinct from ends_at
          or published_worksite_id is distinct from worksite_id
          or published_note is distinct from note);
  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    perform push_event(jsonb_build_object('type', 'rota', 'company_id', v_company, 'from', p_from, 'to', p_to));
  end if;
  return v_removed + v_updated;
end;
$$;
revoke execute on function publish_rota(timestamptz, timestamptz) from public, anon;
grant execute on function publish_rota(timestamptz, timestamptz) to authenticated;

-- Every 5 minutes: late starts, no-shows, long shifts and shift reminders.
select cron.unschedule(jobid) from cron.job where jobname = 'aero-push-tick';
select cron.schedule('aero-push-tick', '*/5 * * * *', $$select public.push_event('{"type": "tick"}'::jsonb)$$);


-- Update for September 2026: only allow clock-in on site.
-- Run it once in the Supabase SQL editor. Safe to run again.
--
-- The owner's decision (17 Sep 2026), replacing "flag, never block" for
-- clock-in when a company has require_on_site on (the default):
--   * no location from the phone -> clock-in refused ("turn on location")
--   * outside the zone -> refused, with a GPS margin of up to 50m taken from
--     the accuracy the phone reports
--   * clocking OUT is never blocked: it is recorded and flagged as before,
--     so a forgotten clock-out can't keep a shift running all night.
-- A company that switches require_on_site off gets the old behaviour back.

alter table companies add column if not exists require_on_site boolean not null default true;
revoke update on table companies from authenticated;
grant update (name, show_pay, use_rota, require_on_site) on table companies to authenticated;

-- Replaces the three-argument clock_in: keeping both would make every call
-- ambiguous. Pages that don't send p_accuracy still work (no margin).
drop function if exists clock_in(uuid, double precision, double precision);

create or replace function clock_in(
  p_worksite_id uuid,
  p_lat double precision default null,
  p_lng double precision default null,
  p_accuracy double precision default null
) returns shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := current_company_id();
  v_strict  boolean;
  v_site    worksites;
  v_metres  double precision;
  v_margin  double precision;
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

  select require_on_site into v_strict from companies where id = v_company;

  if p_lat is not null and p_lng is not null then
    v_metres := metres_between(p_lat, p_lng, v_site.lat, v_site.lng);
    -- Phone GPS is often 20-50m out; give up to 50m of the reported accuracy.
    v_margin := least(greatest(coalesce(p_accuracy, 0), 0), 50);
    v_ok := v_metres <= v_site.radius_m + v_margin;
    if coalesce(v_strict, false) and not v_ok then
      raise exception 'You are %m from %. Move inside the site zone to clock in.',
        round(v_metres), v_site.name;
    end if;
  else
    if coalesce(v_strict, false) then
      raise exception 'Turn on location to clock in. Your phone needs to show you are at %.', v_site.name;
    end if;
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

revoke execute on function clock_in(uuid, double precision, double precision, double precision) from public, anon;
grant execute on function clock_in(uuid, double precision, double precision, double precision) to authenticated;


commit;


-- Update for September 2026: breaks.
-- Run it once in the Supabase SQL editor, after the on-site clock-in update.
-- Safe to run again.
--
-- Staff tap Start break and End break themselves. The minutes are added up on
-- the shift, and every hours figure in both apps takes them off — so an unpaid
-- lunch is no longer paid by mistake.
--
-- Two decisions worth knowing:
--   * A break is only ever unpaid time inside a shift. There is no "paid
--     break" setting, because nobody taps a break they are paid for.
--   * Clocking out closes an open break automatically. People forget, and a
--     shift left "on break" for fourteen hours would wreck the timesheet.
--
-- Each company can switch breaks off (companies.use_breaks) — a yard where
-- nobody stops does not want the button on screen.
begin;

alter table companies add column if not exists use_breaks boolean not null default true;
alter table shifts    add column if not exists break_minutes integer not null default 0
  check (break_minutes >= 0);
alter table shifts    add column if not exists break_started_at timestamptz;

-- ── START ───────────────────────────────────────────────────────────────
create or replace function start_break()
returns shifts
language plpgsql security definer set search_path = public
as $$
declare v_shift shifts; v_company companies;
begin
  select * into v_shift from shifts
   where user_id = auth.uid() and clock_out_at is null
   order by clock_in_at desc limit 1;
  if not found then raise exception 'You are not clocked in.'; end if;

  select * into v_company from companies where id = v_shift.company_id;
  if not coalesce(v_company.use_breaks, true) then
    raise exception 'Breaks are switched off for this company.';
  end if;
  if v_shift.break_started_at is not null then
    raise exception 'You are already on a break.';
  end if;

  update shifts set break_started_at = now() where id = v_shift.id returning * into v_shift;
  return v_shift;
end;
$$;

-- ── END ─────────────────────────────────────────────────────────────────
-- Rounded to the nearest minute, and never negative if a clock drifts.
create or replace function end_break()
returns shifts
language plpgsql security definer set search_path = public
as $$
declare v_shift shifts; v_mins integer;
begin
  select * into v_shift from shifts
   where user_id = auth.uid() and clock_out_at is null
   order by clock_in_at desc limit 1;
  if not found then raise exception 'You are not clocked in.'; end if;
  if v_shift.break_started_at is null then raise exception 'You are not on a break.'; end if;

  v_mins := greatest(0, round(extract(epoch from (now() - v_shift.break_started_at)) / 60)::int);
  update shifts set
    break_minutes    = break_minutes + v_mins,
    break_started_at = null
  where id = v_shift.id
  returning * into v_shift;
  return v_shift;
end;
$$;

-- ── CLOCKING OUT CLOSES AN OPEN BREAK ───────────────────────────────────
-- Same function as before, with those three lines added.
create or replace function clock_out(
  p_lat double precision default null,
  p_lng double precision default null,
  p_note text default ''
) returns shifts
language plpgsql security definer set search_path = public
as $$
declare
  v_site   worksites;
  v_metres double precision;
  v_ok     boolean;
  v_shift  shifts;
  v_mins   integer := 0;
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

  -- Somebody who forgot to end their break is not on a fourteen-hour lunch.
  if v_shift.break_started_at is not null then
    v_mins := greatest(0, round(extract(epoch from (now() - v_shift.break_started_at)) / 60)::int);
  end if;

  update shifts set
    clock_out_at     = now(),
    clock_out_lat    = p_lat,
    clock_out_lng    = p_lng,
    clock_out_metres = round(v_metres)::int,
    clock_out_ok     = v_ok,
    break_minutes    = break_minutes + v_mins,
    break_started_at = null,
    note             = coalesce(nullif(p_note, ''), note)
  where id = v_shift.id
  returning * into v_shift;

  return v_shift;
end;
$$;

revoke execute on function start_break(), end_break() from public, anon;
grant execute on function start_break(), end_break() to authenticated;

commit;


-- Update for September 2026: the staff privacy notice.
-- Run it once in the Supabase SQL editor. Safe to run again.
--
-- The app shows every member of staff a plain-English notice about what is
-- kept about them, the first time they sign in and any time under Account.
-- The notice text lives in the pages (it changes with the company's settings);
-- this update stores the two things only the company can supply, and a record
-- that each person was shown it.
--
--   * companies.privacy_contact  who staff ask about their data
--   * companies.retention_text   how long records are kept, in the company's words
--   * privacy_ack                who has read which version, and when
--
-- The record is its own table, not a column on profiles, for the same reason
-- pay rates are: colleagues can read profiles, and nobody needs to see when
-- somebody else read a notice. Staff see their own row; managers see the
-- company's. Nobody writes to it directly: acknowledge_privacy() does.
--
-- Nothing here blocks anyone. The app treats a missing table as "no record
-- kept yet" and simply doesn't ask, so the pages can go out before this SQL.
begin;

alter table companies add column if not exists privacy_contact text not null default ''
  check (length(privacy_contact) <= 200);
alter table companies add column if not exists retention_text text not null default ''
  check (length(retention_text) <= 200);

create table if not exists privacy_ack (
  user_id     uuid primary key references profiles(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  version     integer not null default 1,
  seen_at     timestamptz not null default now()
);

alter table privacy_ack enable row level security;
drop policy if exists privacy_ack_read on privacy_ack;
create policy privacy_ack_read on privacy_ack for select to authenticated
  using (company_id = current_company_id() and (user_id = auth.uid() or is_manager()));

revoke all on table privacy_ack from anon, authenticated;
grant select on table privacy_ack to authenticated;

-- Reading the notice again after an update replaces the old record.
create or replace function acknowledge_privacy(p_version integer default 1)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_company uuid := current_company_id();
begin
  if v_company is null then raise exception 'Your account is inactive.'; end if;
  insert into privacy_ack (user_id, company_id, version, seen_at)
    values (auth.uid(), v_company, greatest(coalesce(p_version, 1), 1), now())
    on conflict (user_id) do update
      set version = excluded.version, seen_at = now(), company_id = excluded.company_id;
end;
$$;

revoke execute on function acknowledge_privacy(integer) from public, anon;
grant execute on function acknowledge_privacy(integer) to authenticated;

commit;


-- Update for September 2026: a shift can only point at people and sites of its own company.
-- Run it once in the Supabase SQL editor. Safe to run again. Changes no data.
--
-- Found by the tenant isolation check (checks/isolation.mjs). Nothing leaked:
-- another company's rows stayed invisible and unchanged. But the manager rule on
-- `shifts` only asked "is this row in my company?", so a manager could save a
-- shift in their own company that POINTED AT another company's worksite or
-- person. It needs that company's private ids, which nobody outside it ever
-- sees, so it is an integrity hole rather than a leak. rota_shifts already asks
-- the extra question on every write; this gives shifts the same rule.
begin;

drop policy if exists shifts_manage on shifts;
create policy shifts_manage on shifts for all to authenticated
  using (company_id = current_company_id() and is_manager())
  with check (company_id = current_company_id() and is_manager()
              and exists (select 1 from profiles p
                          where p.id = shifts.user_id and p.company_id = shifts.company_id)
              and (shifts.worksite_id is null
                   or exists (select 1 from worksites w
                              where w.id = shifts.worksite_id and w.company_id = shifts.company_id)));

commit;


-- Update for September 2026: "Add a client" and per-company settings.
-- Run it once in the Supabase SQL editor. Safe to run again. Changes no data.
--
--   1. platform_admins   the people (you) allowed to add client companies.
--                        Nobody can read or write it from the app or the website;
--                        only the `platform` Edge Function (service key) looks at it.
--   2. companies gets    time_zone (default Europe/London), currency (default GBP)
--                        and brand_name (default blank: the app says "Aero Attendance").
--   3. A FIX for a gap that was already there: the breaks and privacy-notice
--      updates added columns to companies but never allowed a manager to save
--      them, so "Save" in Company settings failed with "permission denied for
--      table companies". This lists every column a manager may change.
--
-- AFTER RUNNING IT, make yourself a platform admin (ONE TIME, replace the email
-- with the one you sign in with):
--
--   insert into platform_admins (user_id)
--   select id from auth.users where email = 'YOUR-EMAIL-HERE'
--   on conflict do nothing;
begin;

-- ── 1. PLATFORM ADMINS ──────────────────────────────────────────────────
create table if not exists platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table platform_admins enable row level security;
-- No policy on purpose: with row-level security on and no policy, nobody but the
-- service key can see or change a row. The revoke is the second lock.
revoke all on table platform_admins from anon, authenticated;

-- ── 2. PER-COMPANY SETTINGS ─────────────────────────────────────────────
alter table companies add column if not exists time_zone  text not null default 'Europe/London'
  check (length(time_zone) between 1 and 64);
alter table companies add column if not exists currency   text not null default 'GBP'
  check (currency ~ '^[A-Z]{3}$');
alter table companies add column if not exists brand_name text not null default ''
  check (length(brand_name) <= 60);

-- A time zone the database does not know would only fail later, in a push
-- notification, so refuse it when it is saved. The message is shown as it is.
create or replace function companies_check_settings()
returns trigger
language plpgsql
as $$
begin
  begin
    perform now() at time zone new.time_zone;
  exception when others then
    raise exception '"%" is not a time zone the database knows. Use a name like Europe/London.', new.time_zone;
  end;
  return new;
end;
$$;

drop trigger if exists companies_check_settings on companies;
create trigger companies_check_settings
  before insert or update of time_zone on companies
  for each row execute function companies_check_settings();

-- ── 3. WHAT A MANAGER MAY CHANGE ON THEIR OWN COMPANY ───────────────────
-- Never id, created_at or anything else: a client cannot rewrite its own row's identity.
revoke update on table companies from authenticated;
grant update (name, show_pay, use_rota, require_on_site, use_breaks,
              privacy_contact, retention_text, time_zone, currency, brand_name)
  on table companies to authenticated;

commit;


-- Update for September 2026: managers can change a person's role, safely.
-- Run it once in the Supabase SQL editor. Safe to run again. Changes no data.
--
-- What it closes: a manager could already write to any profile in their own
-- company straight from the browser, so nothing stopped an admin (manager) making
-- themselves the owner, demoting the owner, or switching the owner off. This
-- puts the rules in the database, where the page cannot bypass them:
--   * nobody's role can be changed to or from "owner" from the app
--   * nobody can change their OWN role
--   * nobody can remove or restore themselves or the owner
-- The service key (the Edge Functions) is not held to this, because it has no
-- signed-in user: manage-staff's own checks apply there.
begin;

create or replace function profiles_guard()
returns trigger
language plpgsql
as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then return new; end if;   -- the service key and the database owner

  if new.role is distinct from old.role then
    if old.role = 'owner' then raise exception 'The company owner''s role cannot be changed.'; end if;
    if new.role = 'owner'  then raise exception 'Nobody can be made the owner from the app.'; end if;
    if old.id = v_me       then raise exception 'You cannot change your own role.'; end if;
  end if;

  if new.active is distinct from old.active and (old.role = 'owner' or old.id = v_me) then
    raise exception 'You cannot remove or restore yourself or the company owner.';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard on profiles;
create trigger profiles_guard
  before update of role, active on profiles
  for each row execute function profiles_guard();

commit;


-- Update for September 2026: pause a client.
-- Run it once in the Supabase SQL editor. Safe to run again. Changes no data.
--
-- The /platform page can now PAUSE a client (for example one that has not paid) and
-- un-pause them, without deleting anything. A paused company's people can still sign
-- in, but the database shows them nothing and lets them do nothing until it is
-- un-paused: current_company_id() and is_manager(), which every policy and function
-- depends on, stop recognising them. Their data is untouched.
--
-- `suspended` is deliberately NOT in the list of columns a manager may change: a
-- client cannot pause or un-pause itself. Only the platform function (service key) can.
begin;

alter table companies add column if not exists suspended boolean not null default false;

-- Both stay security definer: see WHO AM I? in schema.sql.
create or replace function current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.company_id
  from profiles p join companies c on c.id = p.company_id
  where p.id = auth.uid() and p.active and not c.suspended
$$;

create or replace function is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles p join companies c on c.id = p.company_id
    where p.id = auth.uid() and p.role in ('owner','admin') and p.active and not c.suspended
  )
$$;

-- Lets the pages say "this account is paused" instead of "you are not attached to a company".
-- Answers only about the caller's own company, and only true or false.
create or replace function my_company_paused()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.suspended from profiles p join companies c on c.id = p.company_id
                   where p.id = auth.uid() and p.active), false)
$$;

revoke execute on function my_company_paused() from public, anon;
grant execute on function my_company_paused() to authenticated;


-- ── AUDIT HISTORY ───────────────────────────────────────────────────────
-- Who did what, for the manager's Audit tab. Only the database writes to it:
-- write_audit_event is revoked from `authenticated`, so a browser cannot forge
-- or backdate an entry.
create table if not exists audit_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  actor_id    uuid references profiles(id) on delete set null,
  action      text not null check (length(trim(action)) between 1 and 80),
  entity      text not null check (length(trim(entity)) between 1 and 80),
  entity_id   uuid,
  summary     text not null check (length(trim(summary)) between 1 and 500),
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_events_company_date
  on audit_events(company_id, created_at desc);

alter table audit_events enable row level security;
drop policy if exists audit_events_manager_read on audit_events;
create policy audit_events_manager_read on audit_events
  for select to authenticated
  using (company_id = current_company_id() and is_manager());

revoke all on audit_events from anon, authenticated;
grant select on audit_events to authenticated;

create or replace function write_audit_event(
  p_company_id uuid,
  p_actor_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid,
  p_summary text,
  p_details jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_events(company_id, actor_id, action, entity, entity_id, summary, details)
  values (p_company_id, p_actor_id, trim(p_action), trim(p_entity), p_entity_id,
          left(trim(p_summary), 500), coalesce(p_details, '{}'::jsonb));
end;
$$;

revoke all on function write_audit_event(uuid,uuid,text,text,uuid,text,jsonb) from public, anon, authenticated;

create or replace function audit_shift_correction_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform write_audit_event(new.company_id, new.user_id, 'requested', 'shift_correction', new.id,
      'Staff member requested a shift correction.', jsonb_build_object('status', new.status));
  elsif tg_op = 'UPDATE' and (new.status is distinct from old.status or new.reviewed_by is distinct from old.reviewed_by) then
    perform write_audit_event(new.company_id, new.reviewed_by, new.status, 'shift_correction', new.id,
      'Manager ' || new.status || ' a shift correction.', jsonb_build_object('review_note', new.review_note));
  end if;
  return new;
end;
$$;

drop trigger if exists shift_corrections_audit on shift_corrections;
create trigger shift_corrections_audit
  after insert or update on shift_corrections
  for each row execute function audit_shift_correction_event();

create or replace function audit_rota_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_action text;
begin
  v_action := case when tg_op = 'INSERT' then 'created'
                   when coalesce(new.removed, false) and not coalesce(old.removed, false) then 'removed'
                   when tg_op = 'UPDATE' then 'updated'
                   else 'changed' end;
  perform write_audit_event(new.company_id, auth.uid(), v_action, 'rota_shift', new.id,
    'Manager ' || v_action || ' a rota shift.', jsonb_build_object('starts_at', new.starts_at, 'ends_at', new.ends_at));
  return new;
end;
$$;

drop trigger if exists rota_shifts_audit on rota_shifts;
create trigger rota_shifts_audit
  after insert or update on rota_shifts
  for each row execute function audit_rota_event();


-- ── A MANAGER CLOSING A FORGOTTEN SHIFT ─────────────────────────────────
-- Somebody drives off without clocking out and the manager has to close it.
-- This MUST NOT be a plain update on shifts: clock_out() is what closes an
-- open break, and skipping it leaves break_started_at set and those minutes
-- never taken off the paid hours. It also records who did it, because a shift
-- somebody else ended is pay data and has to be attributable.
create or replace function clock_out_for(p_shift_id uuid, p_reason text default '')
returns shifts
language plpgsql security definer set search_path = public
as $$
declare
  v_shift shifts;
  v_mins  integer := 0;
  v_who   text;
begin
  if not coalesce(is_manager(), false) then
    raise exception 'Manager access required.';
  end if;

  select * into v_shift from shifts
   where id = p_shift_id and company_id = current_company_id();
  if not found then
    raise exception 'That shift is not one of yours.';
  end if;
  if v_shift.clock_out_at is not null then
    raise exception 'That shift is already closed.';
  end if;

  if v_shift.break_started_at is not null then
    v_mins := greatest(0, round(extract(epoch from (now() - v_shift.break_started_at)) / 60)::int);
  end if;

  update shifts set
    clock_out_at     = now(),
    clock_out_ok     = null,        -- a manager closed it: nobody knows where they were
    break_minutes    = break_minutes + v_mins,
    break_started_at = null
  where id = v_shift.id
  returning * into v_shift;

  select full_name into v_who from profiles where id = v_shift.user_id;
  perform write_audit_event(v_shift.company_id, auth.uid(), 'clocked_out', 'shift', v_shift.id,
    'Manager clocked out ' || coalesce(v_who, 'a member of staff') || '.',
    jsonb_build_object('reason', nullif(trim(p_reason), ''), 'break_minutes_added', v_mins));

  return v_shift;
end;
$$;
revoke execute on function clock_out_for(uuid, text) from public, anon;
grant execute on function clock_out_for(uuid, text) to authenticated;


-- ── SHIFT HANDOVER ──────────────────────────────────────────────────────
-- The next person on a worksite sees the note the last person left.
--
-- shifts_read lets a member of staff read their OWN shifts only, which is right
-- and stays that way. This is the one narrow exception, and it is deliberately
-- mean with what it gives back: no parameter (so nobody can walk through the
-- company's worksites — it uses the caller's own open or most recent shift), and
-- it returns the note, when that shift ended and the worksite name, but NOT who
-- wrote it, their hours or their location.
create or replace function my_handover()
returns table (note text, ended_at timestamptz, worksite text)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select s.worksite_id
      from shifts s
     where s.user_id = auth.uid()
       and s.company_id = current_company_id()
       and s.worksite_id is not null
     order by (s.clock_out_at is null) desc, s.clock_in_at desc
     limit 1
  )
  select btrim(s.note), s.clock_out_at, w.name
    from shifts s
    join mine on mine.worksite_id = s.worksite_id
    left join worksites w on w.id = s.worksite_id
   where s.company_id = current_company_id()
     and s.user_id <> auth.uid()
     and s.clock_out_at is not null
     and s.clock_out_at > now() - interval '24 hours'
     and coalesce(btrim(s.note), '') <> ''
   order by s.clock_out_at desc
   limit 1
$$;

revoke execute on function my_handover() from public, anon;
grant execute on function my_handover() to authenticated;


-- ── OVERTIME APPROVAL (optional, off by default) ────────────────────────
-- A company sets a weekly threshold in Company settings; any week a person
-- works more than that is listed for a manager to approve or reject, and
-- approved hours come out in their own column in the CSV export.
--
-- The week's hours are worked out from the shifts every time, never stored and
-- kept in step, so a corrected shift cannot leave a stale figure behind. Only
-- the DECISION is stored, and it keeps the hours it was made against so a
-- manager can see if the week has moved since.
--
-- Weeks start on Monday in the company's own time zone, so a Sunday night shift
-- falls in the week the people working it would say it does.
alter table companies add column if not exists overtime_weekly_hours numeric(5,2)
  check (overtime_weekly_hours is null or (overtime_weekly_hours > 0 and overtime_weekly_hours <= 168));

create table if not exists overtime_decisions (
  company_id        uuid not null references companies(id) on delete cascade,
  user_id           uuid not null references profiles(id) on delete cascade,
  week_start        date not null,
  status            text not null check (status in ('approved','rejected')),
  hours_at_decision numeric(6,2) not null,
  note              text not null default '' check (length(note) <= 300),
  decided_by        uuid references profiles(id) on delete set null,
  decided_at        timestamptz not null default now(),
  primary key (company_id, user_id, week_start)
);
alter table overtime_decisions enable row level security;

drop policy if exists overtime_read on overtime_decisions;
create policy overtime_read on overtime_decisions for select to authenticated
  using (company_id = current_company_id() and (user_id = auth.uid() or is_manager()));

-- No insert/update/delete grant on purpose: decide_overtime() is the only way
-- in, so every decision has an author and an audit entry.
revoke all on table overtime_decisions from anon, authenticated;
grant select on table overtime_decisions to authenticated;

-- NOT security definer: row-level security already gives a manager their whole
-- company and a member of staff only their own, which is exactly what is wanted.
-- Do not "optimise" it into a definer function.
create or replace function overtime_weeks(p_from date, p_to date)
returns table (
  user_id   uuid,
  full_name text,
  week_start date,
  hours     numeric,
  threshold numeric,
  overtime  numeric,
  status    text,
  note      text,
  decided_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with co as (
    select id, coalesce(time_zone, 'Europe/London') as tz, overtime_weekly_hours as ot
      from companies
     where id = current_company_id()
  ),
  weeks as (
    select s.user_id,
           (date_trunc('week', s.clock_in_at at time zone co.tz))::date as week_start,
           sum(extract(epoch from (s.clock_out_at - s.clock_in_at)) / 3600.0
               - coalesce(s.break_minutes, 0) / 60.0) as hours
      from shifts s
      cross join co
     where s.company_id = co.id
       and s.clock_out_at is not null
     group by 1, 2
  )
  select w.user_id,
         p.full_name,
         w.week_start,
         round(w.hours, 2),
         co.ot,
         round(w.hours - co.ot, 2),
         d.status,
         coalesce(d.note, ''),
         d.decided_at
    from weeks w
    cross join co
    join profiles p on p.id = w.user_id
    left join overtime_decisions d
      on d.company_id = co.id and d.user_id = w.user_id and d.week_start = w.week_start
   where co.ot is not null
     and w.hours > co.ot
     and w.week_start >= p_from
     and w.week_start <= p_to
   order by w.week_start desc, p.full_name
$$;

revoke execute on function overtime_weeks(date, date) from public, anon;
grant execute on function overtime_weeks(date, date) to authenticated;

-- Recomputes the hours at the moment of the decision rather than trusting
-- anything the browser sends.
create or replace function decide_overtime(p_user_id uuid, p_week_start date, p_status text, p_note text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := current_company_id();
  v_tz      text;
  v_ot      numeric;
  v_hours   numeric;
  v_who     text;
begin
  if not coalesce(is_manager(), false) then
    raise exception 'Manager access required.';
  end if;
  if p_status is null or p_status not in ('approved', 'rejected') then
    raise exception 'Choose approve or reject.';
  end if;

  select coalesce(time_zone, 'Europe/London'), overtime_weekly_hours
    into v_tz, v_ot
    from companies where id = v_company;
  if v_ot is null then
    raise exception 'Overtime approval is switched off for this company.';
  end if;

  if not exists (select 1 from profiles where id = p_user_id and company_id = v_company) then
    raise exception 'That person is not one of yours.';
  end if;

  select coalesce(sum(extract(epoch from (clock_out_at - clock_in_at)) / 3600.0
                      - coalesce(break_minutes, 0) / 60.0), 0)
    into v_hours
    from shifts
   where company_id = v_company
     and user_id = p_user_id
     and clock_out_at is not null
     and (date_trunc('week', clock_in_at at time zone v_tz))::date = p_week_start;

  insert into overtime_decisions (company_id, user_id, week_start, status, hours_at_decision, note, decided_by)
  values (v_company, p_user_id, p_week_start, p_status, round(v_hours, 2), left(coalesce(p_note, ''), 300), auth.uid())
  on conflict (company_id, user_id, week_start) do update
     set status            = excluded.status,
         hours_at_decision = excluded.hours_at_decision,
         note              = excluded.note,
         decided_by        = excluded.decided_by,
         decided_at        = now();

  select full_name into v_who from profiles where id = p_user_id;
  perform write_audit_event(v_company, auth.uid(), p_status, 'overtime', null,
    'Manager ' || p_status || ' overtime for ' || coalesce(v_who, 'a member of staff') ||
    ', week of ' || to_char(p_week_start, 'DD Mon YYYY') || '.',
    jsonb_build_object('week_start', p_week_start, 'hours', round(v_hours, 2),
                       'threshold', v_ot, 'note', nullif(trim(coalesce(p_note, '')), '')));
end;
$$;

revoke execute on function decide_overtime(uuid, date, text, text) from public, anon;
grant execute on function decide_overtime(uuid, date, text, text) to authenticated;

-- Re-issue the whole list. A column added without this is a column managers
-- cannot save, which is exactly how Company settings broke in 1.0.
revoke update on table companies from authenticated;
grant update (name, show_pay, use_rota, require_on_site, use_breaks,
              privacy_contact, retention_text, time_zone, currency, brand_name,
              overtime_weekly_hours)
  on table companies to authenticated;

commit;
