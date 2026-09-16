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
begin;

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

commit;
