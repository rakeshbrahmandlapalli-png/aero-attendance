-- Update for September 2026: a shift can only point at people and sites of its own company.
-- Run it once in the Supabase SQL editor. Safe to run again. Changes no data.
--
-- Found by the tenant isolation check (checks/isolation.mjs). Nothing leaked:
-- another company's rows stayed invisible and unchanged. But the manager rule on
-- `shifts` only asked "is this row in my company?", so a manager could save a
-- shift in their own company that POINTED AT another company's worksite or
-- person. It needs that company's private ids, which nobody outside it ever
-- sees, so it is an integrity hole rather than a leak. rota_shifts already asks
-- the extra question on every write; this gives shifts the same rule.
begin;

drop policy if exists shifts_manage on shifts;
create policy shifts_manage on shifts for all to authenticated
  using (company_id = current_company_id() and is_manager())
  with check (company_id = current_company_id() and is_manager()
              and exists (select 1 from profiles p
                          where p.id = shifts.user_id and p.company_id = shifts.company_id)
              and (shifts.worksite_id is null
                   or exists (select 1 from worksites w
                              where w.id = shifts.worksite_id and w.company_id = shifts.company_id)));

commit;
