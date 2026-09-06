-- Row-Level Security example: per-owner data isolation on the `jobs` table.
--
-- Every table in the app follows this same pattern — auth.uid() must match
-- the row's owner_id for any operation to succeed. This is enforced at the
-- database layer, not just in application code, so a bug in a route handler
-- (e.g. a missing .eq("owner_id", ...) filter) can't leak another user's
-- data — Postgres itself refuses the query.

alter table public.jobs enable row level security;

create policy "jobs_select_own"
  on public.jobs
  for select
  using (auth.uid() = owner_id);

create policy "jobs_insert_own"
  on public.jobs
  for insert
  with check (auth.uid() = owner_id);

create policy "jobs_update_own"
  on public.jobs
  for update
  using (auth.uid() = owner_id);

create policy "jobs_delete_own"
  on public.jobs
  for delete
  using (auth.uid() = owner_id);
