-- Aero Attendance — announcements (September 2026)
--
-- A manager writes a short message; everyone in that company sees it on Home
-- until they dismiss it. Dismissing records that the person read it, so the
-- manager can see who has not.
--
-- Safe to run more than once. Already folded into setup/schema.sql.

create table if not exists announcements (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  author_id   uuid references profiles(id) on delete set null,
  body        text not null check (length(btrim(body)) between 1 and 500),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  active      boolean not null default true
);
create index if not exists announcements_company_idx on announcements(company_id, created_at desc);
alter table announcements enable row level security;

-- Staff see live ones only. Managers see every one, so they can reopen or
-- switch off something they posted earlier.
drop policy if exists announcements_read on announcements;
create policy announcements_read on announcements for select to authenticated
  using (company_id = current_company_id()
         and (is_manager()
              or (active and (expires_at is null or expires_at > now()))));

drop policy if exists announcements_manage on announcements;
create policy announcements_manage on announcements for all to authenticated
  using (company_id = current_company_id() and is_manager())
  with check (company_id = current_company_id() and is_manager()
              and (author_id is null
                   or exists (select 1 from profiles p
                              where p.id = announcements.author_id
                                and p.company_id = announcements.company_id)));

-- Who has seen what. A read is a fact: it can be written once and never
-- edited or withdrawn, so there is no update or delete grant below.
create table if not exists announcement_reads (
  announcement_id uuid not null references announcements(id) on delete cascade,
  user_id         uuid not null references profiles(id) on delete cascade,
  company_id      uuid not null references companies(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
alter table announcement_reads enable row level security;

drop policy if exists announcement_reads_read on announcement_reads;
create policy announcement_reads_read on announcement_reads for select to authenticated
  using (company_id = current_company_id() and (user_id = auth.uid() or is_manager()));

drop policy if exists announcement_reads_own on announcement_reads;
create policy announcement_reads_own on announcement_reads for insert to authenticated
  with check (company_id = current_company_id() and user_id = auth.uid()
              and exists (select 1 from announcements a
                          where a.id = announcement_reads.announcement_id
                            and a.company_id = announcement_reads.company_id));

revoke all on table announcements, announcement_reads from anon;
grant select, insert, update, delete on table announcements to authenticated;
grant select, insert on table announcement_reads to authenticated;
