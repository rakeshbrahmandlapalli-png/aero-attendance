-- Aero Attendance — rota notifications (September 2026)
--
-- Publishing a rota already asked the send-push function to tell staff. Two gaps:
--
--   1. A person whose ONLY change was a shift being taken off the rota was never
--      told. The message went out only when a shift was updated, and the function
--      worked out who to tell by looking for people who still had shifts.
--      publish_rota() now records exactly who was affected, removals included, and
--      sends their ids with the message.
--
--   2. Nobody could see who could not be reached. A phone notification needs the
--      person to have switched notifications on, on their own phone, so the
--      manager was left guessing why somebody "never got it". rota_reach() says.
--
-- The send-push Edge Function has to be redeployed for (1) to take effect. Until it
-- is, it ignores the ids and behaves exactly as before, so nothing breaks.
--
-- Safe to run more than once. Already folded into setup/schema.sql.

create or replace function publish_rota(p_from timestamptz, p_to timestamptz)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid := current_company_id();
  v_removed integer;
  v_updated integer;
  v_gone    uuid[];
  v_changed uuid[];
begin
  if not coalesce(is_manager(), false) then raise exception 'Manager access required.'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '32 days' then
    raise exception 'Choose a week to publish.';
  end if;

  -- Keep WHO was affected. A person whose only shift was taken off the rota has
  -- no shift left to find afterwards, and still needs telling.
  with gone as (
    delete from rota_shifts
     where company_id = v_company and removed
       and coalesce(published_starts_at, starts_at) >= p_from
       and coalesce(published_starts_at, starts_at) < p_to
     returning user_id)
  select count(*)::int, coalesce(array_agg(distinct user_id), '{}'::uuid[])
    into v_removed, v_gone from gone;

  with changed as (
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
            or published_note is distinct from note)
     returning user_id)
  select count(*)::int, coalesce(array_agg(distinct user_id), '{}'::uuid[])
    into v_updated, v_changed from changed;

  if v_removed + v_updated > 0 then
    perform push_event(jsonb_build_object(
      'type', 'rota', 'company_id', v_company, 'from', p_from, 'to', p_to, 'at', now(),
      'user_ids', (select coalesce(jsonb_agg(distinct u), '[]'::jsonb) from unnest(v_gone || v_changed) u)));
  end if;
  return v_removed + v_updated;
end;
$$;
revoke execute on function publish_rota(timestamptz, timestamptz) from public, anon;
grant execute on function publish_rota(timestamptz, timestamptz) to authenticated;

-- Everyone with a published shift in the range, and whether a phone notification
-- can reach them: a phone that has allowed notifications, and rota alerts not
-- switched off. Managers only, and only for their own company. It says nothing
-- about WHICH phone, and nothing about anyone without a shift.
create or replace function rota_reach(p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, full_name text, phones integer, wants boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         p.full_name,
         (select count(*)::int from push_subscriptions s where s.user_id = p.id),
         coalesce((select np.rota from notification_prefs np where np.user_id = p.id), true)
    from profiles p
   where coalesce(is_manager(), false)
     and p.company_id = current_company_id()
     and exists (select 1 from rota_shifts r
                  where r.user_id = p.id and r.company_id = p.company_id and not r.removed
                    and r.published_starts_at >= p_from and r.published_starts_at < p_to)
   order by p.full_name
$$;
revoke execute on function rota_reach(timestamptz, timestamptz) from public, anon;
grant execute on function rota_reach(timestamptz, timestamptz) to authenticated;
