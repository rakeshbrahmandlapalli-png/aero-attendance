-- Aero Attendance — shift handover (September 2026)
--
-- Staff already write a note when they clock out. Until now only managers could
-- read it, so the next person on that worksite never saw what was left for them.
--
-- shifts_read lets a member of staff read their OWN shifts only, which is right
-- and stays that way. This function is the one narrow exception, and it is
-- deliberately mean with what it gives back:
--
--   * no parameter, so nobody can walk through the company's worksites: it uses
--     the caller's own open shift, or their most recent one, to decide which
--     worksite they are asking about
--   * it returns the note, when that shift ended, and the worksite name. NOT who
--     wrote it, not their hours, not their location
--   * only a note left in the last 24 hours, and never the caller's own
--
-- Safe to run more than once. Already folded into setup/schema.sql.

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
