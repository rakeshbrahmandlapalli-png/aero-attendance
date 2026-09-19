-- Aero Attendance — check that notifications work (September 2026)
--
-- Every notification (a rota publish, a notice, someone clocking in) is sent by the
-- DATABASE calling the send-push function, with no login, through pg_net. That call
-- is asynchronous and the database never looks at the answer, so when it fails, for
-- example because the function was redeployed with Verify JWT switched back on and
-- now answers 401, nothing anywhere says so. People just never get a notification.
--
-- push_check() sends a real test down that same route and returns the request id;
-- push_check_result() reads back what the function answered. The manager board turns
-- that into a plain sentence. Managers only.
--
-- push_check_result() returns only the status, whether it timed out, any error and
-- how many phones the test reached. Never the body of the response.
--
-- Safe to run more than once. Already folded into setup/schema.sql.

begin;

create or replace function push_check()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_url text; v_id bigint;
begin
  if not coalesce(is_manager(), false) then raise exception 'Manager access required.'; end if;
  select function_url into v_url from push_config;
  if v_url is null then raise exception 'push_config has no function address, so nothing can be sent.'; end if;
  select net.http_post(
    url := v_url,
    body := jsonb_build_object('type', 'test', 'user_id', auth.uid()),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 10000
  ) into v_id;
  return v_id;
end;
$$;
revoke execute on function push_check() from public, anon;
grant execute on function push_check() to authenticated;

create or replace function push_check_result(p_id bigint)
returns table (status_code integer, timed_out boolean, error_msg text, sent integer)
language sql
stable
security definer
set search_path = public
as $$
  select r.status_code,
         coalesce(r.timed_out, false),
         r.error_msg,
         coalesce(((regexp_match(r.content, '"sent"\s*:\s*([0-9]+)'))[1])::int, 0)
    from net._http_response r
   where r.id = p_id and coalesce(is_manager(), false)
$$;
revoke execute on function push_check_result(bigint) from public, anon;
grant execute on function push_check_result(bigint) to authenticated;

commit;
