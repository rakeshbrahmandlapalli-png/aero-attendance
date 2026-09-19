-- Update for September 2026: managers can change a person's role, safely.
-- Run it once in the Supabase SQL editor. Safe to run again. Changes no data.
--
-- What it closes: a manager could already write to any profile in their own
-- company straight from the browser, so nothing stopped an admin (manager) making
-- themselves the owner, demoting the owner, or switching the owner off. This
-- puts the rules in the database, where the page cannot bypass them:
--   * nobody's role can be changed to or from "owner" from the app
--   * nobody can change their OWN role
--   * nobody can remove or restore themselves or the owner
-- The service key (the Edge Functions) is not held to this, because it has no
-- signed-in user: manage-staff's own checks apply there.
begin;

create or replace function profiles_guard()
returns trigger
language plpgsql
as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then return new; end if;   -- the service key and the database owner

  if new.role is distinct from old.role then
    if old.role = 'owner' then raise exception 'The company owner''s role cannot be changed.'; end if;
    if new.role = 'owner'  then raise exception 'Nobody can be made the owner from the app.'; end if;
    if old.id = v_me       then raise exception 'You cannot change your own role.'; end if;
  end if;

  if new.active is distinct from old.active and (old.role = 'owner' or old.id = v_me) then
    raise exception 'You cannot remove or restore yourself or the company owner.';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard on profiles;
create trigger profiles_guard
  before update of role, active on profiles
  for each row execute function profiles_guard();

commit;
