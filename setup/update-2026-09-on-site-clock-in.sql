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
begin;

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
