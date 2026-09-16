-- Update for September 2026: rota & availability, and leavers losing access.
-- Run it once in the Supabase SQL editor. Safe to run again.

-- ── ROTA & AVAILABILITY (optional, off by default) ─────────────────────
-- A company switches this on in Company settings. Staff keep a usual week
-- and book days off; managers draft shifts and publish a week when it's
-- ready. Staff only ever see the PUBLISHED copy of a shift (published_*
-- columns), so a manager can rework a week without staff watching it change.
-- Safe to run again.
begin;

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

commit;
