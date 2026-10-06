-- ============================================================================
--  Day Dial — schedule seed
--
--  Run this ONCE after schema.sql if you want reminders to arrive with the browser
--  closed. supabase/cron.sql needs this table to know what is due.
--
--  This mirrors src/lib/schedule.ts exactly. If you change one, change the other —
--  the app's copy is the source of truth for the dial, this copy is only there so
--  the database can answer "what starts in the next five minutes" on its own.
--
--  Lunch is 13:00 → 14:00. The handwritten notes said 1:00–2:20 PM while the study
--  block below it said 2:00–5:00 PM, a 20 minute overlap. Lunch ends at 14:00.
--
--  Times are stored as timestamptz computed in IST, so the job fires on IST
--  boundaries no matter where the database or the browser is.
-- ============================================================================

create table if not exists public.day_blocks (
  id        text        primary key,
  title     text        not null,
  label     text        not null,
  kind      text        not null check (kind in ('study', 'exercise', 'hobby', 'life')),
  timed     boolean     not null default false,
  start_at  timestamptz not null,
  end_at    timestamptz not null,
  constraint day_blocks_order check (end_at > start_at)
);

comment on table public.day_blocks is
  'Mirror of src/lib/schedule.ts, read only by the 5-minute dispatch job.';

alter table public.day_blocks enable row level security;

revoke all on table public.day_blocks from anon, authenticated;
grant select on table public.day_blocks to anon, authenticated, service_role;

create policy day_blocks_select on public.day_blocks
  for select to anon, authenticated using (true);

-- Rebuild from the app's schedule, for today's date in IST.
-- Times below are HH24:MI in Asia/Kolkata.
insert into public.day_blocks (id, title, label, kind, timed, start_at, end_at)
values
  ('wake',            'Wake up',                'Wake',       'life',     false,
    (current_date at time zone 'Asia/Kolkata') + interval '8 hours 30 minutes',
    (current_date at time zone 'Asia/Kolkata') + interval '8 hours 30 minutes' + interval '40 minutes'),

  ('exercise',        'Exercise, eat and bath', 'Exercise',   'exercise', true,
    (current_date at time zone 'Asia/Kolkata') + interval '8 hours 30 minutes',
    (current_date at time zone 'Asia/Kolkata') + interval '9 hours 10 minutes'),

  ('ready',           'Get ready',              'Get ready',  'life',     false,
    (current_date at time zone 'Asia/Kolkata') + interval '9 hours 10 minutes',
    (current_date at time zone 'Asia/Kolkata') + interval '10 hours'),

  ('study-morning',   'Study — morning',        'Study',      'study',    true,
    (current_date at time zone 'Asia/Kolkata') + interval '10 hours',
    (current_date at time zone 'Asia/Kolkata') + interval '13 hours'),

  ('lunch',           'Lunch',                  'Lunch',      'life',     false,
    (current_date at time zone 'Asia/Kolkata') + interval '13 hours',
    (current_date at time zone 'Asia/Kolkata') + interval '14 hours'),

  ('study-afternoon', 'Study — afternoon',      'Study',      'study',    true,
    (current_date at time zone 'Asia/Kolkata') + interval '14 hours',
    (current_date at time zone 'Asia/Kolkata') + interval '17 hours'),

  ('break',           'Break',                  'Break',      'life',     false,
    (current_date at time zone 'Asia/Kolkata') + interval '17 hours',
    (current_date at time zone 'Asia/Kolkata') + interval '18 hours'),

  ('study-evening',   'Study — evening',        'Study',      'study',    true,
    (current_date at time zone 'Asia/Kolkata') + interval '18 hours',
    (current_date at time zone 'Asia/Kolkata') + interval '20 hours'),

  ('dinner',          'Dinner',                 'Dinner',     'life',     false,
    (current_date at time zone 'Asia/Kolkata') + interval '20 hours',
    (current_date at time zone 'Asia/Kolkata') + interval '21 hours'),

  ('study-night',     'Study — night',          'Study',      'study',    true,
    (current_date at time zone 'Asia/Kolkata') + interval '21 hours',
    (current_date at time zone 'Asia/Kolkata') + interval '22 hours'),

  ('hobby',           'Hobby',                  'Hobby',      'hobby',    true,
    (current_date at time zone 'Asia/Kolkata') + interval '22 hours',
    (current_date at time zone 'Asia/Kolkata') + interval '24 hours')
on conflict (id) do update
  set title    = excluded.title,
      label    = excluded.label,
      kind     = excluded.kind,
      timed    = excluded.timed,
      start_at = excluded.start_at,
      end_at   = excluded.end_at;

-- Sanity check: twelve blocks, seven timed, nine hours of study.
select
  count(*)                                              as blocks,
  count(*) filter (where timed)                         as timed,
  sum(extract(epoch from (end_at - start_at)) / 3600)
    filter (where kind = 'study')                       as study_hours
from public.day_blocks;

-- The rows shift by a day every midnight, so re-run this daily, or add a second
-- pg_cron job at 00:05 IST that calls the same insert with a `current_date` that has
-- already rolled over. Simplest version:
--
--   select cron.schedule('day-dial-reseed', '5 0 * * *', $$
--     update public.day_blocks
--        set start_at = (current_date at time zone 'Asia/Kolkata')
--                      + (start_at at time zone 'Asia/Kolkata') - (current_date - 1),
--            end_at   = (current_date at time zone 'Asia/Kolkata')
--                      + (end_at   at time zone 'Asia/Kolkata') - (current_date - 1);
--   $$);