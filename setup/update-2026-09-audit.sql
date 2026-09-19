-- Audit history for manager actions and attendance corrections.
-- Safe to run more than once. Run this in Supabase SQL Editor as the owner.

create table if not exists audit_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  actor_id    uuid references profiles(id) on delete set null,
  action      text not null check (length(trim(action)) between 1 and 80),
  entity      text not null check (length(trim(entity)) between 1 and 80),
  entity_id   uuid,
  summary     text not null check (length(trim(summary)) between 1 and 500),
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_events_company_date
  on audit_events(company_id, created_at desc);

alter table audit_events enable row level security;
drop policy if exists audit_events_manager_read on audit_events;
create policy audit_events_manager_read on audit_events
  for select to authenticated
  using (company_id = current_company_id() and is_manager());

revoke all on audit_events from anon, authenticated;
grant select on audit_events to authenticated;

create or replace function write_audit_event(
  p_company_id uuid,
  p_actor_id uuid,
  p_action text,
  p_entity text,
  p_entity_id uuid,
  p_summary text,
  p_details jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_events(company_id, actor_id, action, entity, entity_id, summary, details)
  values (p_company_id, p_actor_id, trim(p_action), trim(p_entity), p_entity_id,
          left(trim(p_summary), 500), coalesce(p_details, '{}'::jsonb));
end;
$$;

revoke all on function write_audit_event(uuid,uuid,text,text,uuid,text,jsonb) from public, anon, authenticated;

create or replace function audit_shift_correction_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform write_audit_event(new.company_id, new.user_id, 'requested', 'shift_correction', new.id,
      'Staff member requested a shift correction.', jsonb_build_object('status', new.status));
  elsif tg_op = 'UPDATE' and (new.status is distinct from old.status or new.reviewed_by is distinct from old.reviewed_by) then
    perform write_audit_event(new.company_id, new.reviewed_by, new.status, 'shift_correction', new.id,
      'Manager ' || new.status || ' a shift correction.', jsonb_build_object('review_note', new.review_note));
  end if;
  return new;
end;
$$;

drop trigger if exists shift_corrections_audit on shift_corrections;
create trigger shift_corrections_audit
  after insert or update on shift_corrections
  for each row execute function audit_shift_correction_event();

create or replace function audit_rota_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_action text;
begin
  v_action := case when tg_op = 'INSERT' then 'created'
                   when coalesce(new.removed, false) and not coalesce(old.removed, false) then 'removed'
                   when tg_op = 'UPDATE' then 'updated'
                   else 'changed' end;
  perform write_audit_event(new.company_id, auth.uid(), v_action, 'rota_shift', new.id,
    'Manager ' || v_action || ' a rota shift.', jsonb_build_object('starts_at', new.starts_at, 'ends_at', new.ends_at));
  return new;
end;
$$;

drop trigger if exists rota_shifts_audit on rota_shifts;
create trigger rota_shifts_audit
  after insert or update on rota_shifts
  for each row execute function audit_rota_event();

