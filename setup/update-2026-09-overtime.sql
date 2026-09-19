-- Aero Attendance — overtime approval (September 2026)
--
-- Run update-2026-09-audit.sql FIRST: a decision is recorded through
-- write_audit_event().
--
-- Off by default. A company sets a weekly threshold in Company settings; any
-- week a person works more than that is listed for a manager to approve or
-- reject, and approved hours come out in their own column in the CSV export.
--
-- The week's hours are worked out from the shifts themselves every time, never
-- stored and kept in step, so a corrected shift cannot leave a stale figure
-- behind. Only the DECISION is stored, and it keeps the hours it was made
-- against so a manager can see if the week has moved since.
--
-- Weeks start on Monday in the company's own time zone, so a Sunday night shift
-- falls in the week the people working it would say it does.
--
-- Safe to run more than once. Already folded into setup/schema.sql.

begin;

alter table companies add column if not exists overtime_weekly_hours numeric(5,2)
  check (overtime_weekly_hours is null or (overtime_weekly_hours > 0 and overtime_weekly_hours <= 168));

-- One row per person per week, written only by decide_overtime() below.
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

-- No insert/update/delete grant on purpose: decide_overtime() is the only way in,
-- so every decision has an author and an audit entry.
revoke all on table overtime_decisions from anon, authenticated;
grant select on table overtime_decisions to authenticated;

-- Every week over the threshold, with its decision if one has been made.
-- NOT security definer: row-level security already gives a manager their whole
-- company and a member of staff only their own, and that is exactly what is
-- wanted here. Do not "optimise" it into a definer function.
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

-- A manager approving or rejecting one week. Recomputes the hours at the moment
-- of the decision rather than trusting anything the browser sends.
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
