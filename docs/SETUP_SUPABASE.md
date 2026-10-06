# Getting Supabase set up — step by step

Follow this top to bottom. It takes about ten minutes. At the end you will have a
Project URL, a publishable key, a secret key, three tables, and a scheduled job that
runs every five minutes.

> **First, a security note.** The `sbp_…` token supplied at the start of this
> project is a **Personal Access Token** with *Organization* scope and
> *Full access*. It can read and write every project in your organization, including
> API keys and members. It was pasted into a chat, so treat it as compromised.
> Revoke it in **Account Preferences → Access Tokens**, and if you need one again,
> scope it to a single project and set a short expiry.
>
> Its literal value was removed from this file for the same reason it should never have
> been written down: a secret copied into a document is a secret that leaks with the
> document. Revoking the token is what actually fixes this — editing the text does not.
>
> The app never needs that token. It needs a **publishable** key, which is safe in
> browser code.

---

## Step 1 — Open the project and find its keys

1. Go to <https://supabase.com/dashboard> and sign in.
2. Click your project name in the left sidebar to open it.
   *(If you do not have a project yet: click **New project**, pick a name, generate a
   database password and **save it in a password manager** — you will need it for the
   database password, and it is not recoverable from the dashboard.)*
3. In the left sidebar, click **Project Settings**.
4. Click **API Keys**.
5. Click the **Publishable and secret API keys** tab.

You should now see three things:

| What the page calls it | What it looks like | Where it goes |
|---|---|---|
| Project URL | `https://xxxxxxxx.supabase.co` | `NEXT_PUBLIC_SUPABASE_URL` |
| **Publishable** key | `sb_publishable_…` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| **Secret** key | `sb_secret_…` | `SUPABASE_SECRET_KEY` (server only, never in the browser) |

> There may also be legacy keys called `anon` and `service_role`. They still work,
> but Supabase is deprecating them at the end of 2026. **Use the publishable key.**

**Copy all three now.** The secret key is only shown in full once.

### Write them into the app

Open `.env.local` in this project (create it by copying `.env.local.example`) and fill
in the three values. Then paste just the **Project URL**, the **publishable key**, and
your **plan** (Free or Pro) back here — never the secret key.

---

## Step 2 — Run the schema

The app needs three tables. They are already written for you in `supabase/schema.sql`.

1. In the left sidebar click **SQL Editor**.
2. Click **New Query**.
3. Open `supabase/schema.sql` in your editor, select all, copy.
4. Paste into the SQL Editor.
5. Press **Ctrl + Enter** (Windows) or **Cmd + Enter** (Mac), or click **Run**.
6. Look at the **Results** panel underneath. You want to see success with no red error.

> **Why the file is important.** Supabase's SQL Editor runs as the `postgres`
> superuser, which can see every table regardless of permissions. That means the
> Editor is a bad place to *test* whether your policies work — it will always look
> fine. To test properly you have to use the app, which connects as `anon`.

### Three things in that file that are not optional

**A. Explicit `GRANT` on every table.** On **30 October 2026** Supabase stops
auto-exposing new tables in the `public` schema to the Data API. After that date a
table without a `GRANT` fails with:

```
42501 permission denied for table timer_blocks
```

The file grants them up front so this never bites you.

**B. Row Level Security, switched on explicitly.** Tables you create in the **SQL
Editor** do *not* get RLS enabled. Only the **Table Editor** does that for you. The
file enables it per table. Since there is no login, every policy is `using (true)` —
that is correct for a single-user app. What protects the data is that only you have
the URL and key.

**C. `gen_random_uuid()`, no extensions.** This has been built into Postgres since
version 13, so there is nothing to install. Do not add `pgcrypto` or `uuid-ossp`; the
old advice is out of date.

### Check it worked

Run these three queries, one at a time, in the SQL Editor.

**1. RLS is on for all three tables** — every row must say `true`:

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;
```

**2. Policies exist** — each table needs four (`select`, `insert`, `update`, `delete`):

```sql
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

**3. The tables have the grants** — look for `anon=` in the ACL:

```sql
select relname, relacl
from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r';
```

---

## Step 3 — Generate the Web Push keys

Web Push needs a VAPID keypair so the browser and your server agree on who is
sending.

In this project's terminal:

```
npm run vapid
```

It prints two lines. Put them in `.env.local`:

```
VAPID_PUBLIC_KEY=BPxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
VAPID_PRIVATE_KEY=qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
VAPID_SUBJECT=mailto:you@example.com
```

- **`VAPID_PUBLIC_KEY`** goes to the browser. It is public and that is correct.
- **`VAPID_PRIVATE_KEY`** is the private half. Never put it in any `NEXT_PUBLIC_`
  variable, never commit it. It is **not** a PEM block — if it starts with
  `-----BEGIN` it is wrong and the server will throw on boot.
- **`VAPID_SUBJECT`** is how push services contact you if something breaks. Use a
  real `mailto:` address.

Restart `npm run dev` after adding them.

---

## Step 4 — Turn on notifications in the browser

The app asks for permission itself, but you can pre-approve:

**Chrome / Edge** — click the icon to the right of the address bar → **Site settings
→ Notifications → Allow**. Then reload the app. In the header, **Notifications** should
change from *Blocked* to *On*.

**Firefox** — click the padlock in the address bar → **Clear permission** next to
*Send notifications*, then reload.

**Safari** — Safari on macOS **does not support Web Push in a normal tab**. It works
only in a web app installed to the Dock (Safari → File → Add to Dock). Without that
you get in-page notifications instead, which is the designed fallback.

> **How honest should I be about "works when the browser is closed"?** On desktop,
> push generally requires *a* browser process running. Fully quitting the browser may
> delay or drop delivery; leaving the app open in a window is reliable. The app
> schedules every reminder twice — once through push and once in-page — so a missed
> push never means a missed reminder while you have the tab open.

---

## Step 5 — Create the 5-minute scheduled job

This is what sends the notifications when no browser tab is open. It lives in your
database, not in your app server.

1. Click **Database** in the left sidebar → **Extensions**.
2. Find **`pg_net`** → click **Enable**.
   *(It installs into the `extensions` schema, which is deliberate — it keeps `net`
   out of `public` so it does not show up in the security audit.)*
3. Find **`pg_cron`** → click **Enable**. If it is not listed, run this in the SQL
   Editor instead:
   ```sql
   create extension pg_cron with schema pg_catalog;
   grant usage on schema cron to postgres;
   grant all privileges on all tables in schema cron to postgres;
   ```
4. Store your deployment URL and secret key where the job can read them. Run in the
   SQL Editor, replacing the two placeholders:
   ```sql
   select vault.create_secret('sb_secret_xxxxxxxxxxxxxxxxxxxx_yyyyyyyy', 'planner_secret_key');
   select vault.create_secret('https://your-app.vercel.app',              'planner_app_url');
   ```
5. Open `supabase/cron.sql`, copy it, paste into the SQL Editor, run it.

You should see a request id. Confirm the job exists:

```sql
select jobid, jobname, schedule, active from cron.job;
```

And after a few minutes, that it actually ran:

```sql
select jobname, start_time, status, return_message
from cron.job_run_details
order by start_time desc limit 10;
```

`status = 0` means success.

### Do not add a Vercel cron for this

If you deploy to Vercel, **do not** put `*/5 * * * *` in `vercel.json`. Hobby
accounts are limited to one cron per day and a more frequent expression **fails at
deploy time**. The Supabase job above is the correct mechanism and it works on the
free plan.

### Keep the run history table small

`cron.job_run_details` grows forever and is never cleaned up, even after you delete a
job. `supabase/cron.sql` creates a second job that prunes anything older than a week.

---

## Step 6 — Confirm the whole thing

1. `npm run dev`
2. Open the app.
3. The header should read **Notifications: On** and **Backend: Supabase**.
4. Open DevTools → **Application → Service Workers**. `sw.js` should be registered and
   *activated*.
5. DevTools → **Application → Push Messaging**. You should see an endpoint, a
   `p256dh` key and an `auth` secret.
6. Check the row landed in the database:
   ```sql
   select endpoint, created_at from public.push_subscriptions;
   ```

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `permission denied for table …` | Missing `GRANT`, or you created the tables before running our SQL | Re-run `supabase/schema.sql` |
| `Could not find table in schema cache` | Table not visible to the Data API | Check **Integrations → Data API → Settings → Exposed tables** |
| Returns `200` with an empty array | Grant is fine but a policy filtered everything out | Check `pg_policies` |
| `Could not find table 'push_subscriptions'` from the app but the SQL Editor sees it | PostgREST schema cache is stale | Run `notify pgrst, 'reload config';` |
| Notifications say *Blocked* | Permission denied, or you are in Safari | Chrome/Edge: site settings → Allow. Safari: add to Dock |
| Push arrives but the panel never opens | The service worker's click handler opened a new tab that could not reach the page | Click the notification again; the tab re-registers on load |
| Nothing arrives at all, tab closed | `pg_cron` job failing, or the app URL in Vault is wrong | `select * from cron.job_run_details order by start_time desc limit 10;` |
| `ENOTFOUND` from `pg_net` | The Vault URL has a typo | Re-run the `vault.create_secret` call |

> **Free plan warning.** A free Supabase project **pauses after one week of
> inactivity**, and a paused project stops running cron jobs — your reminders would
> silently stop. If this becomes a habit rather than a test, upgrade to Pro.