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
