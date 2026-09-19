-- Aero Attendance — a manager closing a forgotten shift (September 2026)
--
-- Run update-2026-09-audit.sql FIRST: this function records who closed the
-- shift through write_audit_event().
--
-- Why this exists: the manager board used to close a shift with a plain update
-- on `shifts`. That skips clock_out(), which is what closes a break somebody
-- left running — so the break never ended, its minutes were never taken off the
-- paid hours, and the shift was paid for time on break.
--
-- Safe to run more than once. Already folded into setup/schema.sql.

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
