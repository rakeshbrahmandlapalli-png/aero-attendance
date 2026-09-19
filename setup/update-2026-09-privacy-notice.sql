-- Update for September 2026: the staff privacy notice.
-- Run it once in the Supabase SQL editor. Safe to run again.
--
-- The app shows every member of staff a plain-English notice about what is
-- kept about them, the first time they sign in and any time under Account.
-- The notice text lives in the pages (it changes with the company's settings);
-- this update stores the two things only the company can supply, and a record
-- that each person was shown it.
--
--   * companies.privacy_contact  who staff ask about their data
--   * companies.retention_text   how long records are kept, in the company's words
--   * privacy_ack                who has read which version, and when
--
-- The record is its own table, not a column on profiles, for the same reason
-- pay rates are: colleagues can read profiles, and nobody needs to see when
-- somebody else read a notice. Staff see their own row; managers see the
-- company's. Nobody writes to it directly: acknowledge_privacy() does.
--
-- Nothing here blocks anyone. The app treats a missing table as "no record
-- kept yet" and simply doesn't ask, so the pages can go out before this SQL.
begin;

alter table companies add column if not exists privacy_contact text not null default ''
  check (length(privacy_contact) <= 200);
alter table companies add column if not exists retention_text text not null default ''
  check (length(retention_text) <= 200);

create table if not exists privacy_ack (
  user_id     uuid primary key references profiles(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  version     integer not null default 1,
  seen_at     timestamptz not null default now()
);

alter table privacy_ack enable row level security;
drop policy if exists privacy_ack_read on privacy_ack;
create policy privacy_ack_read on privacy_ack for select to authenticated
  using (company_id = current_company_id() and (user_id = auth.uid() or is_manager()));

revoke all on table privacy_ack from anon, authenticated;
grant select on table privacy_ack to authenticated;

-- Reading the notice again after an update replaces the old record.
create or replace function acknowledge_privacy(p_version integer default 1)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_company uuid := current_company_id();
begin
  if v_company is null then raise exception 'Your account is inactive.'; end if;
  insert into privacy_ack (user_id, company_id, version, seen_at)
    values (auth.uid(), v_company, greatest(coalesce(p_version, 1), 1), now())
    on conflict (user_id) do update
      set version = excluded.version, seen_at = now(), company_id = excluded.company_id;
end;
$$;

revoke execute on function acknowledge_privacy(integer) from public, anon;
grant execute on function acknowledge_privacy(integer) to authenticated;

commit;
