-- ============================================================================
--  Day Dial — schema
--
--  Apply this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query),
--  or with `npm run db:push`.
--
--  Three tables, one per job:
--
--    day_state          the whole day as one JSONB row. A single-user app does not
--                       benefit from twelve rows and a dozen joins.
--    push_subscriptions one row per browser that can receive Web Push.
--    dispatch_log       what the 5-minute job has already sent, so a retry or a
--                       double-fired cron can never send the same reminder twice.
--
--  ── READ THIS BEFORE SKIPPING THE GRANTS ─────────────────────────────────
--
--  On 30 October 2026 Supabase stops auto-exposing new tables in `public` to the
--  Data API. From that date a table without an explicit GRANT fails with:
--
--      42501 permission denied for table day_state
--
--  Note the symptom difference: a missing GRANT is an error, whereas a policy that
--  filters every row out is a 200 with an empty array. If you get an empty array,
--  your grants are fine and you have a policy problem.
--
--  Also note: tables created in the SQL Editor do NOT get RLS enabled. Only the
--  Table Editor does that for you. Everything below enables it explicitly.
-- ============================================================================

-- ── 1. the day ───────────────────────────────────────────────────────────────
create table if not exists public.day_state (
  day        date        primary key,
  payload    jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.day_state is
  'One row per calendar day. payload holds the DaySnapshot written by the app.';

-- ── 2. push subscriptions ────────────────────────────────────────────────────
create table if not exists public.push_subscriptions (
  id           uuid        primary key default gen_random_uuid(),
  endpoint     text        not null unique,
  p256dh       text        not null,
  auth         text        not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

comment on table public.push_subscriptions is
  'One row per browser. Rows are pruned by the send route on a 404 or 410 from the push service.';

-- ── 3. dispatch log ──────────────────────────────────────────────────────────
--  The 5-minute job can fire twice, the network can retry, and two instances can
--  overlap. This table makes "exactly once" enforceable rather than hopeful.
create table if not exists public.dispatch_log (
  id        bigint      generated always as identity primary key,
  day       date        not null,
  slot_key  text        not null,
  sent_at   timestamptz not null default now(),
  unique (day, slot_key)
);

comment on table public.dispatch_log is
  'Idempotency guard. Insert first; a conflict means this reminder already went out.';

create index if not exists dispatch_log_day_idx on public.dispatch_log (day);

-- ── updated_at maintenance ───────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists day_state_touch on public.day_state;
create trigger day_state_touch
  before update on public.day_state
  for each row execute function public.touch_updated_at();


-- ============================================================================
--  Grants, RLS and policies
--
--  Grants decide whether the Data API can see a table at all. RLS decides which
--  rows it may touch. You need both; a policy without a grant protects nothing.
--
--  There is no login in this app, so every client request arrives as the `anon`
--  role and the policies are `using (true)`. That is correct for a single-user
--  app: the security boundary is the obscurity of the project URL and key, not
--  row-level rules. If you ever add a login, every policy here needs revisiting.
-- ============================================================================

alter table public.day_state          enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.dispatch_log      enable row level security;

revoke all on table public.day_state          from anon, authenticated;
revoke all on table public.push_subscriptions from anon, authenticated;
revoke all on table public.dispatch_log      from anon, authenticated;

grant select, insert, update, delete on table public.day_state          to anon, authenticated, service_role;
grant select, insert, update, delete on table public.push_subscriptions to anon, authenticated, service_role;
grant select, insert, update, delete on table public.dispatch_log      to anon, authenticated, service_role;

-- Postgres rejects several operations in one `for` clause, so it is one policy each.
do $$
declare
  t text;
begin
  foreach t in array array['day_state', 'push_subscriptions', 'dispatch_log'] loop
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_select', t);
    execute format('create policy %I on public.%I for insert to anon, authenticated with check (true)', t || '_insert', t);
    execute format('create policy %I on public.%I for update to anon, authenticated using (true) with check (true)', t || '_update', t);
    execute format('create policy %I on public.%I for delete to anon, authenticated using (true)', t || '_delete', t);
  end loop;
end;
$$;

-- Stop future tables being auto-exposed too, so the 30 October change cannot
-- surprise you again on the next table you add.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;


-- ============================================================================
--  Verify after running this
-- ============================================================================
--
--  1. RLS on for all three:
--       select tablename, rowsecurity from pg_tables where schemaname = 'public';
--
--  2. Policies present:
--       select tablename, policyname, cmd, roles from pg_policies
--        where schemaname = 'public' order by tablename, policyname;
--
--  3. Grants present — look for anon= in the ACL:
--       select relname, relacl from pg_class
--        where relnamespace = 'public'::regnamespace and relkind = 'r';
--
--  Remember the SQL Editor runs as `postgres`, which bypasses RLS. It will always
--  show you rows. To test policies honestly, use the app, which connects as `anon`.