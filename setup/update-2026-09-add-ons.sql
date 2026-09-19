-- Aero Attendance — per-client add-ons (September 2026)
--
-- Two different things, kept apart on purpose:
--
--   ADD-ON   the OWNER (you, on /platform) decides whether a client has a
--            feature at all. A client cannot switch on something they have not
--            been given.
--   SETTING  the CLIENT's manager decides how a feature they do have behaves
--            (the overtime threshold, whether pay is shown, and so on).
--
-- A feature appears only if it is both given and switched on. Take the add-on
-- away and its setting disappears from Company settings too.
--
-- The table stores only what has been switched OFF. No row means the client has
-- the feature, which is what keeps this safe to deploy to clients already live:
-- running it changes nothing for anybody until you untick something.
--
-- Only the platform Edge Function writes here, with the service key. There is
-- no insert, update or delete grant, so a client's own manager cannot give
-- themselves a feature from the browser.
--
-- Safe to run more than once. Already folded into setup/schema.sql.

begin;

create table if not exists company_features (
  company_id uuid not null references companies(id) on delete cascade,
  feature    text not null check (feature in
               ('rota','pay','breaks','notices','handover','overtime','incidents')),
  enabled    boolean not null,
  updated_at timestamptz not null default now(),
  primary key (company_id, feature)
);
alter table company_features enable row level security;

-- Everybody in the company may READ what they have, so the app knows what to
-- show. Nobody may write it.
drop policy if exists company_features_read on company_features;
create policy company_features_read on company_features for select to authenticated
  using (company_id = current_company_id());

revoke all on table company_features from anon, authenticated;
grant select on table company_features to authenticated;

-- True unless there is a row saying otherwise.
create or replace function has_feature(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select cf.enabled from company_features cf
      where cf.company_id = current_company_id() and cf.feature = p_feature),
    true)
$$;

revoke execute on function has_feature(text) from public, anon;
grant execute on function has_feature(text) to authenticated;

-- ── Enforce it where the data lives, not just in the page ────────────────
-- Hiding a button is not taking a feature away. Each of these refuses or
-- returns nothing when the add-on is off, so unticking it on /platform is real.

-- Notices: nothing to read, and nothing new to post.
drop policy if exists announcements_read on announcements;
create policy announcements_read on announcements for select to authenticated
  using (company_id = current_company_id()
         and has_feature('notices')
         and (is_manager()
              or (active and (expires_at is null or expires_at > now()))));

drop policy if exists announcements_manage on announcements;
create policy announcements_manage on announcements for all to authenticated
  using (company_id = current_company_id() and is_manager() and has_feature('notices'))
  with check (company_id = current_company_id() and is_manager() and has_feature('notices')
              and (author_id is null
                   or exists (select 1 from profiles p
                              where p.id = announcements.author_id
                                and p.company_id = announcements.company_id)));

-- Handover: the next person is handed nothing.
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
   where has_feature('handover')
     and s.company_id = current_company_id()
     and s.user_id <> auth.uid()
     and s.clock_out_at is not null
     and s.clock_out_at > now() - interval '24 hours'
     and coalesce(btrim(s.note), '') <> ''
   order by s.clock_out_at desc
   limit 1
$$;

revoke execute on function my_handover() from public, anon;
grant execute on function my_handover() to authenticated;

-- Overtime: no week is listed, and nothing can be decided.
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
       and has_feature('overtime')
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
  if not coalesce(has_feature('overtime'), false) then
    raise exception 'Overtime is not part of this company''s plan.';
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

commit;
