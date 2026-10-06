-- ============================================================================
--  Day Dial — the 5-minute reminder job
--
--  Apply after supabase/schema.sql, in the SQL Editor.
--
--  WHY THIS LIVES IN POSTGRES AND NOT IN NEXT.JS
--
--  Two reasons, and the first one is not negotiable:
--
--    1. Vercel Hobby allows cron jobs that run ONCE PER DAY. A */5 expression does
--       not get throttled — it FAILS THE DEPLOY. So a 5-minute trigger cannot live
--       in vercel.json on a Hobby account.
--    2. Serverless functions cannot hold a timer. A setInterval inside a route
--       handler is killed when the instance recycles at maxDuration.
--
--  pg_cron supports */5 on every Supabase plan, and it records run history, so you
--  can see whether the job actually fired. See supabase/cron.sql section 3.
--
--  SETUP, IN ORDER
--
--    1. Enable pg_net   (Dashboard → Database → Extensions)
--    2. Enable pg_cron  (Dashboard → Database → Extensions, or the SQL below)
--    3. Store your deployment URL and secret key in Vault
--    4. Replace the three placeholders below and run
--    5. Confirm with:  select * from cron.job_run_details order by start_time desc limit 5;
-- ============================================================================


-- ── 1. extensions ────────────────────────────────────────────────────────────
--  pg_net installs into the `extensions` schema on purpose: that keeps `net` out of
--  `public`, which is what the Supabase security advisor wants to see.
create extension if not exists pg_net with schema extensions;

--  ⚠️ Disabling pg_cron deletes every job permanently. Do not disable it.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

--  Vault is on by default; this is a no-op if it is already there.
create extension if not exists supabase_vault cascade;


-- ── 2. credentials in Vault ──────────────────────────────────────────────────
--  Run these two by hand, replacing the placeholders. Do NOT commit the real values.
--  A secret key hardcoded in SQL is readable by anyone with database access, which
--  defeats the point of having a secret key at all.
--
--    select vault.create_secret('sb_secret_xxxxxxxxxxxxxxxxxxxx_yyyyyyyy', 'planner_secret_key');
--    select vault.create_secret('https://your-app.vercel.app',               'planner_app_url');


-- ── 3. the job ───────────────────────────────────────────────────────────────
--  It computes the IST clock itself, finds which reminders are due in the next five
--  minutes, and asks the app to send them. The app is the only thing that knows the
--  block schedule, so this job stays a dumb, reliable ticker.
select cron.schedule(
  'day-dial-dispatch',
  '*/5 * * * *',
  $job$
    with due as (
      -- Every block that starts within the next five minutes.
      select
        b.id as block_id,
        b.title,
        to_char(b.start_at at time zone 'Asia/Kolkata', 'HH24:MI') as starts,
        round(extract(epoch from (b.end_at - b.start_at)) / 60)::int as minutes,
        'block-' || b.id || '-' || current_date as slot_key
      from public.day_blocks b
      where b.start_at > now()
        and b.start_at <= now() + interval '5 minutes'
        and b.timed
    ),
    water as (
      -- The hourly water slot, on the hour rather than on a lead.
      select
        to_char(g, 'HH24:MI') as starts,
        'water-' || to_char(g, 'HH24:MI') as slot_key
      from generate_series(
        date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '8 hours 30 minutes',
        date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '22 hours',
        interval '60 minutes'
      ) as g
      where g <= now()
        and g > now() - interval '5 minutes'
    )
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'planner_app_url')
             || '/api/push/send',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        -- The secret key goes on the `apikey` header. It is not a JWT, so putting it
        -- in `Authorization: Bearer` returns "Invalid JWT". This is the single most
        -- common pg_net + new-keys mistake.
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'planner_secret_key'),
        'x-dispatch-secret', coalesce(
          (select decrypted_secret from vault.decrypted_secrets where name = 'planner_dispatch_secret'),
          ''
        )
      ),
      body := jsonb_build_object(
        'day', current_date,
        'blocks', coalesce((select jsonb_agg(to_jsonb(due)) from due), '[]'::jsonb),
        'water', coalesce((select jsonb_agg(to_jsonb(water)) from water), '[]'::jsonb)
      ),
      timeout_milliseconds := 5000
    ) as request_id;
  $job$
);


-- ── 4. keep the run history small ─────────────────────────────────────────────
--  cron.job_run_details grows forever and is never pruned, even after you delete a
--  job. One row every five minutes is ~105k rows a year for a single job.
select cron.schedule(
  'day-dial-prune-cron-log',
  '17 3 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '7 days' $$
);


-- ── 5. useful checks ─────────────────────────────────────────────────────────
--  Did the job fire?
--    select jobname, start_time, status, return_message
--      from cron.job_run_details order by start_time desc limit 10;
--  status 0 is success.
--
--  What is scheduled?
--    select jobid, jobname, schedule, active from cron.job;
--
--  What is it doing right now?
--    select pid, application_name, state, query
--      from pg_stat_activity where application_name ilike 'pg_cron';
--
--  Stop it without deleting the definition:
--    select cron.alter_job(
--      job_id := (select jobid from cron.job where jobname = 'day-dial-dispatch'),
--      active := false);
--
--  Delete it outright:
--    select cron.unschedule('day-dial-dispatch');


--  ─────────────────────────────────────────────────────────────────────────────
--  NOTE ON day_blocks
--
--  The job above reads from public.day_blocks, which the app does not create — the
--  schedule is hardcoded in src/lib/schedule.ts, by decision. So this job is a
--  TEMPLATE, not a drop-in: either create and populate day_blocks once (see
--  seed.sql), or delete section 3 and drive reminders from the app instead, in which
--  case the in-page scheduler is your only channel and reminders require an open tab.
--
--  The choice, in short:
--
--    want reminders with the browser closed  →  keep this job, run seed.sql
--    happy with reminders while the tab is open  →  delete section 3, ship it
--  ─────────────────────────────────────────────────────────────────────────────