-- Update for September 2026: "Add a client" and per-company settings.
-- Run it once in the Supabase SQL editor. Safe to run again. Changes no data.
--
--   1. platform_admins   the people (you) allowed to add client companies.
--                        Nobody can read or write it from the app or the website;
--                        only the `platform` Edge Function (service key) looks at it.
--   2. companies gets    time_zone (default Europe/London), currency (default GBP)
--                        and brand_name (default blank: the app says "Aero Attendance").
--   3. A FIX for a gap that was already there: the breaks and privacy-notice
--      updates added columns to companies but never allowed a manager to save
--      them, so "Save" in Company settings failed with "permission denied for
--      table companies". This lists every column a manager may change.
--
-- AFTER RUNNING IT, make yourself a platform admin (ONE TIME, replace the email
-- with the one you sign in with):
--
--   insert into platform_admins (user_id)
--   select id from auth.users where email = 'YOUR-EMAIL-HERE'
--   on conflict do nothing;
begin;

-- ── 1. PLATFORM ADMINS ──────────────────────────────────────────────────
create table if not exists platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table platform_admins enable row level security;
-- No policy on purpose: with row-level security on and no policy, nobody but the
-- service key can see or change a row. The revoke is the second lock.
revoke all on table platform_admins from anon, authenticated;

-- ── 2. PER-COMPANY SETTINGS ─────────────────────────────────────────────
alter table companies add column if not exists time_zone  text not null default 'Europe/London'
  check (length(time_zone) between 1 and 64);
alter table companies add column if not exists currency   text not null default 'GBP'
  check (currency ~ '^[A-Z]{3}$');
alter table companies add column if not exists brand_name text not null default ''
  check (length(brand_name) <= 60);

-- A time zone the database does not know would only fail later, in a push
-- notification, so refuse it when it is saved. The message is shown as it is.
create or replace function companies_check_settings()
returns trigger
language plpgsql
as $$
begin
  begin
    perform now() at time zone new.time_zone;
  exception when others then
    raise exception '"%" is not a time zone the database knows. Use a name like Europe/London.', new.time_zone;
  end;
  return new;
end;
$$;

drop trigger if exists companies_check_settings on companies;
create trigger companies_check_settings
  before insert or update of time_zone on companies
  for each row execute function companies_check_settings();

-- ── 3. WHAT A MANAGER MAY CHANGE ON THEIR OWN COMPANY ───────────────────
-- Never id, created_at or anything else: a client cannot rewrite its own row's identity.
revoke update on table companies from authenticated;
grant update (name, show_pay, use_rota, require_on_site, use_breaks,
              privacy_contact, retention_text, time_zone, currency, brand_name)
  on table companies to authenticated;

commit;
