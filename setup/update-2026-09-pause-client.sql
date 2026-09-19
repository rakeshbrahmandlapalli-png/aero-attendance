-- Update for September 2026: pause a client.
-- Run it once in the Supabase SQL editor. Safe to run again. Changes no data.
--
-- The /platform page can now PAUSE a client (for example one that has not paid) and
-- un-pause them, without deleting anything. A paused company's people can still sign
-- in, but the database shows them nothing and lets them do nothing until it is
-- un-paused: current_company_id() and is_manager(), which every policy and function
-- depends on, stop recognising them. Their data is untouched.
--
-- `suspended` is deliberately NOT in the list of columns a manager may change: a
-- client cannot pause or un-pause itself. Only the platform function (service key) can.
begin;

alter table companies add column if not exists suspended boolean not null default false;

-- Both stay security definer: see WHO AM I? in schema.sql.
create or replace function current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.company_id
  from profiles p join companies c on c.id = p.company_id
  where p.id = auth.uid() and p.active and not c.suspended
$$;

create or replace function is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles p join companies c on c.id = p.company_id
    where p.id = auth.uid() and p.role in ('owner','admin') and p.active and not c.suspended
  )
$$;

-- Lets the pages say "this account is paused" instead of "you are not attached to a company".
-- Answers only about the caller's own company, and only true or false.
create or replace function my_company_paused()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.suspended from profiles p join companies c on c.id = p.company_id
                   where p.id = auth.uid() and p.active), false)
$$;

revoke execute on function my_company_paused() from public, anon;
grant execute on function my_company_paused() to authenticated;

commit;
