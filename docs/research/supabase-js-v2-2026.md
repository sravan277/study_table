# `@supabase/supabase-js` v2 — Verified Reference (Oct 2026)

Researched against live sources on **2026-10-01**. Versions below were read from the
live npm registry (`npm view`) and the CLI binary itself, not from memory. Every
claim is annotated with how it was verified. Anything I could not verify is in
[§ Unverified / flagged](#unverified--flagged).

---

## 0. Version snapshot (verified via `npm view`)

| Package | Latest | Notes |
| --- | --- | --- |
| `@supabase/supabase-js` | **2.117.2** | `engines.node >= 22.0.0`; peer `@opentelemetry/api >=1.0.0` (optional) |
| `@supabase/ssr` | **0.12.7** | peerDep `@supabase/supabase-js ^2.114.0` |
| `supabase` (CLI) | **2.119.0** | bin `dist/supabase.js` — a shim that downloads the platform binary |
| `next` | 16.3.8 | |
| `react` | 19.3.0 | |
| `typescript` | 7.0.2 | TS 5.0 becomes mandatory for supabase-js on **2027-01-31** |

```bash
npm view @supabase/supabase-js version engines peerDependencies --json
npm view @supabase/ssr version peerDependencies --json
npx supabase@latest --version        # -> supabase 2.119.0
```

---

## 1. Install

### Client-only Next.js App Router app (no auth) — **this is your case**

```bash
npm install @supabase/supabase-js
```

That is the whole install. **`@supabase/ssr` is NOT required.**

The `@supabase/ssr` package exists to persist the Auth session in **cookies** so a
server-rendered request can read it. Its own README says so explicitly:

> `createBrowserClient` and `createServerClient` always store the session in cookies —
> this is the entire point of the package… **If you don't need server-side access to
> the session, use `@supabase/supabase-js`'s `createClient` directly with your own
> `storage` (e.g. `localStorage`) — there's no reason to use `@supabase/ssr` in that case.**

You have **no auth**, so there is no session to make readable server-side.
Installing `@supabase/ssr` would actively make things *worse*: it forces
`flowType: 'pkce'` and ignores any `auth.storage` you pass.

- Source: <https://cdn.jsdelivr.net/npm/@supabase/ssr@0.12.7/README.md>
- Source: <https://github.com/supabase/ssr/blob/main/src/createBrowserClient.ts>

**Only install `@supabase/ssr` if** you later add Supabase Auth and need
Server Components / Route Handlers / Server Actions to read the session.

---

## 2. Client creation

### 2.1 Exact signature — the options param has NOT changed

Verified from `packages/core/supabase-js/src/index.ts` on `master`:

```ts
export const createClient = <
  Database = any,
  SchemaNameOrClientOptions extends
    | (string & keyof Omit<Database, '__InternalSupabase'>)
    | { PostgrestVersion: string } = /* ... */,
  SchemaName extends string & keyof Omit<Database, '__InternalSupabase'> = /* ... */,
>(
  supabaseUrl: string,
  supabaseKey: string,
  options?: SupabaseClientOptions<SchemaName>
): SupabaseClient<Database, SchemaNameOrClientOptions, SchemaName> => { /* ... */ }
```

- Source: <https://github.com/supabase/supabase-js/blob/master/packages/core/supabase-js/src/index.ts>

Still three positional args. **Yes, `auth: { persistSession }` is still valid for
browser usage.** Confirmed in `packages/core/supabase-js/src/lib/types.ts`, and the
defaults are in `src/lib/constants.ts`:

```ts
export const DEFAULT_AUTH_OPTIONS = {
  autoRefreshToken: true,
  persistSession: true,
  detectSessionInUrl: true,
  flowType: 'implicit',
}

export const DEFAULT_DB_OPTIONS = { schema: 'public' }
export const DEFAULT_TRACE_PROPAGATION_OPTIONS = { enabled: false, respectSamplingDecision: true }
```

For a no-auth app, `persistSession` persists a `null` session — harmless. You can set
it to `false` to skip localStorage access entirely:

```ts
createClient(url, key, { auth: { persistSession: false } })
```

New options you did not have to care about in 2024:

```ts
createClient(url, key, {
  db: {
    schema: 'public',
    timeout: 30000,        // ms before the request aborts (PostgREST only)
    urlLengthLimit: 8000,  // warn/hint threshold
    retry: true,           // default true — see §5
  },
  auth: {
    detectSessionInUrl: (url, params) => boolean, // can now be a FUNCTION
    storage: customStorage,
    skipAutoInitialize: false, // SSR: defer auth init to avoid races
  },
  global: { fetch: fetch.bind(globalThis), headers: {} },
  accessToken: async () => string | null, // third-party auth (Clerk/Auth0/Firebase)
  tracePropagation: true,                 // opt-in OTel; needs `@supabase/supabase-js/tracing`
})
```

- Source: <https://github.com/supabase/supabase-js/blob/master/packages/core/supabase-js/src/lib/types.ts>

### 2.2 Which key goes in `createClient(url, key)`

| Key | Works? | Where it goes |
| --- | --- | --- |
| `sb_publishable_...` | **Yes — use this** | `apikey` header only. Deliberately **never** sent as `Authorization: Bearer`. |
| legacy `anon` JWT | **Yes, still works** | `apikey` **and** `Authorization: Bearer`. |
| `sb_secret_...` | Rejected by the platform in a browser | `401`, matched on the `User-Agent` header. |

Exact behaviour (from `SupabaseClient.ts` + `lib/fetch.ts`):

```ts
// packages/core/supabase-js/src/SupabaseClient.ts
const baseUrl = validateSupabaseUrl(supabaseUrl)
if (!supabaseKey) throw new Error('supabaseKey is required.')
checkApiKeyFormat(supabaseKey)
```

```ts
// packages/core/supabase-js/src/SupabaseClient.ts — two fetch wrappers
this.fetch = fetchWithAuth(supabaseKey, supabaseUrl, this._getSessionToken.bind(this),
                           settings.global.fetch, settings.tracePropagation)

// Edge Functions use a dedicated fetch that never falls back to a new-format API key
// in the Authorization header (see `isNewApiKey` in ./lib/fetch). Other services use this.fetch.
this.functionsFetch = fetchWithAuth(..., { omitApiKeyAsBearer: true })
```

Key-format validation as of the current release:

| Input | Result |
| --- | --- |
| `''` / undefined | **throws** `supabaseKey is required.` |
| `sb_publishable_...` | accepted |
| `sb_secret_...` | accepted by the SDK (platform blocks it in browsers with 401) |
| legacy `anon` / `service_role` JWT | accepted |
| `sb_temp_...` | accepted **silently** |
| any other `sb_*` | one-time `console.warn` suggesting an SDK upgrade; client still constructed |

> ⚠️ **Version trap.** `2.110.4` and `2.110.5` **threw** synchronously in the
> constructor for any `sb_` key that wasn't `sb_publishable_`/`sb_secret_`. Fixed by
> #2526 (warn instead of throw). Do not pin to `2.110.4`–`2.110.5`. Use latest.
> The Supabase dashboard itself pinned `2.110.1` to dodge this.
> - Source: <https://github.com/supabase/supabase-js/pull/2526>

Deprecation timeline: `anon` and `service_role` are deprecated for removal **by the
end of 2026**. New projects no longer get them.
- Source: <https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys>
- Source: <https://supabase.com/docs/guides/getting-started/api-keys>

### 2.3 Single shared browser client (singleton)

`@supabase/supabase-js` itself ships **no** singleton — every `createClient()` call
returns a new instance. Only `@supabase/ssr`'s `createBrowserClient` has built-in
singleton behaviour. So you own it.

Next.js App Router + TypeScript, no auth, client-side only:

```ts
// lib/supabase/client.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

let cached: SupabaseClient<Database> | undefined

export function getSupabase(): SupabaseClient<Database> {
  if (!cached) {
    cached = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    )
  }
  return cached
}
```

`.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Use it from a Client Component:

```tsx
'use client'
import { useMemo } from 'react'
import { getSupabase } from '@/lib/supabase/client'

export function StudyTable() {
  // getSupabase() is already memoised, so this is belt-and-braces for React
  const supabase = useMemo(() => getSupabase(), [])
  // ...
}
```

Notes on the pattern:
- The lazy `let` guard is what survives **Fast Refresh** — a module-level
  `export const supabase = createClient(...)` is re-evaluated on hot reload in some
  dev setups, creating a second client (and a second WebSocket).
- Never put the client in a module-scope `let` on the **server**; for a purely
  client-side app you shouldn't be importing this module from RSC at all. Mark
  consumers `'use client'`.
- `createClient` is cheap, so creating one per component would still *work* — but it
  means N WebSocket connections if Realtime is on. One client, one socket.

---

## 3. Data API

### 3.1 Methods confirmed present (verified in source)

`PostgrestQueryBuilder` (`src/PostgrestQueryBuilder.ts`):

```ts
select<Query extends string = '*', ResultOne = ...>(
  columns?: Query,
  options?: { head?: boolean; count?: 'exact' | 'planned' | 'estimated' | (string & {}) }
): PostgrestFilterBuilder<...>

insert(values, { count?, defaultToNull = true })
upsert (values, { onConflict?, ignoreDuplicates = false, count?, defaultToNull = true })
update(values, { count? })
delete({ count? })
```

`PostgrestFilterBuilder` (`src/PostgrestFilterBuilder.ts`):

```ts
eq<ColumnName extends string>(column, value): this      // -> ?col=eq.<value>
neq(column, value): this
gt / gte / lt / lte (column: string, value: unknown): this
in<ColumnName extends string>(column, values: readonly ...[]): this
like / ilike(column, pattern): this
is(column, value: boolean | null): this
match(query: Record<string, unknown>): this
not(column, operator, value): this
or(filters: string): this
filter(column, operator, value): this
```

`PostgrestTransformBuilder` (`src/PostgrestTransformBuilder.ts`):

```ts
select(columns?): this          // on a mutation — adds `Prefer: return=representation`
order(column, { ascending = true, nullsFirst?, referencedTable? }): this
                               //   NOTE: `foreignTable` is @deprecated -> use `referencedTable`
limit(rows, { referencedTable? }): this
range(from, to, { referencedTable? }): this    // INCLUSIVE
abortSignal(signal: AbortSignal): this
single(): PostgrestBuilder<..., Row>
maybeSingle(): PostgrestBuilder<..., Row | null>
csv(): PostgrestBuilder<..., string>
geojson(): PostgrestBuilder<..., Record<string, unknown>>
explain({ analyze?, verbose?, settings?, buffers?, wal?, format? })
rollback(): this               // NEW — sets `Prefer: tx=rollback`, runs in a rolled-back tx
stripNulls(): this             // requires PostgREST 11.2+
setHeader(name, value): this
retry(enabled: boolean): this
maxAffected(rows): this        // PostgREST 13+ only; PATCH / DELETE / RPC only
overrideTypes<NewResult, {merge?}>()   // current
returns<NewResult>()                     // @deprecated
throwOnError()
```

Notable 2025–26 additions you can use today: `.rollback()`, `.setHeader()`,
per-query `.retry(bool)`, `db.timeout`, `db.urlLengthLimit`, `maxAffected()`.

Copy-pasteable core usage:

```ts
const { data, error } = await supabase
  .from('study_sessions')
  .select('id, subject, duration_minutes')
  .eq('completed', true)
  .order('created_at', { ascending: false })
  .limit(20)

// insert — data is NULL unless you chain .select()
const { data: inserted, error: insErr } = await supabase
  .from('study_sessions')
  .insert({ subject: 'Calculus', duration_minutes: 45 })
  .select()
  .single()

// upsert — conflict target must be a UNIQUE column; PK must be in `values`
const { error: upErr } = await supabase
  .from('study_sessions')
  .upsert({ id: 1, subject: 'Calculus', duration_minutes: 60 }, { onConflict: 'id' })

// update — ALWAYS chain a filter
const { error: updErr } = await supabase
  .from('study_sessions')
  .update({ completed: true })
  .eq('id', 1)
```

### 3.2 `.single()` vs `.maybeSingle()` — 0 rows vs many rows

| Modifier | 0 rows | exactly 1 row | 2+ rows |
| --- | --- | --- | --- | --- |
| *(none)* | `data: []`, `error: null` | `data: [row]` | `data: [row, row]` |
| `.single()` | **error**, `data: null`, `status: 406` | `data: row` | **error**, `data: null`, `status: 406` |
| `.maybeSingle()` | `data: null`, **`error: null`** | `data: row` | **error**, `data: null`, `status: 406` |

Mechanics differ between the two, and this matters:

- `.single()` sets `Accept: application/vnd.pgrst.object+json`, so the **server**
  enforces cardinality. It does *not* need `.limit(1)` and you should not add it
  (it hides genuine multi-row bugs).
- `.maybeSingle()` sets **no** `Accept` header. It fetches a list and enforces
  cardinality **client-side** via the internal `isMaybeSingle` flag. This was a
  deliberate fix for <https://github.com/supabase/postgrest-js/issues/361> and now
  applies to **all** HTTP methods, not just GET.

#### Exact error text — `.single()` with 0 rows

PostgREST 12.x (what Supabase currently runs) returns HTTP **406 Not Acceptable**
with this body, which the SDK surfaces verbatim as `error`:

```json
{
  "code": "PGRST116",
  "details": "The result contains 0 rows",
  "hint": null,
  "message": "JSON object requested, multiple (or no) rows returned"
}
```

So the full resolved object is:

```ts
{
  data: null,
  error: {
    code: 'PGRST116',
    details: 'The result contains 0 rows',
    hint: null,
    message: 'JSON object requested, multiple (or no) rows returned',
  },
  count: null,
  status: 406,
  statusText: 'Not Acceptable',
  success: false,
}
```

- Verified: PostgREST error reference + multiple real-world reports, e.g.
  <https://github.com/supabase/supabase/issues/17711> and
  <https://stackoverflow.com/questions/79594920/>
- Client-side status/`success` fields verified in
  <https://github.com/supabase/supabase-js/blob/master/packages/core/postgrest-js/src/PostgrestBuilder.ts>

#### Exact error text — `.maybeSingle()` with 2+ rows

Synthesised **by the client**, not the server (`PostgrestBuilder.processResponse`):

```json
{
  "code": "PGRST116",
  "details": "Results contain 2 rows, application/vnd.pgrst.object+json requires 1 row",
  "hint": null,
  "message": "JSON object requested, multiple (or no) rows returned"
}
```

with `status: 406`, `statusText: 'Not Acceptable'`. The `details` string is
interpolated with the actual row count.

#### Practical rule

```ts
// lookup that may legitimately not exist
const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle()
if (error) throw error
if (!data) return null          // <-- NOT an error

// invariant: exactly one row must exist
const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single()
if (error) throw error          // PGRST116 if the row vanished

// "does this exist?"
const { data, error } = await supabase.from('todos').select('id').eq('id', id).maybeSingle()
```

`.limit(1).maybeSingle()` is the safest idiom when you want to be certain a
`PGRST116` can never fire.

---

## 4. Realtime

### 4.1 `.subscribe()` after `.on()` — **yes, required**

`.on()` only registers a binding on a local channel object. Nothing is sent to the
server until `.subscribe()` fires the join. Every single example in the official
docs chains them. Verified in `RealtimeChannel.ts`:

```ts
subscribe(
  callback?: (status: REALTIME_SUBSCRIBE_STATES, err?: Error) => void,
  timeout = this.timeout
): RealtimeChannel {
  if (!this.socket.isConnected()) {
    this.socket.connect()
  }
  if (this.channelAdapter.isClosed()) {
    /* ... push join, invoke bindings, then callback(status) ... */
  }
  return this
}
```

Note the callback signature is `(status, err)` — the error is the **second**
argument.

```ts
export enum REALTIME_SUBSCRIBE_STATES {
  SUBSCRIBED = 'SUBSCRIBED',
  TIMED_OUT = 'TIMED_OUT',
  CLOSED = 'CLOSED',
  CHANNEL_ERROR = 'CHANNEL_ERROR',
}
```

The channel name can be any string **except `realtime`**.

### 4.2 Exact filter payload shape

The filter object is `RealtimePostgresChangesFilter<T>`, verbatim from
`packages/core/realtime-js/src/RealtimeChannel.ts`:

```ts
export type RealtimePostgresChangesFilter<
  T extends `${REALTIME_POSTGRES_CHANGES_LISTEN_EVENT}`
> = {
  event: T                          // 'INSERT' | 'UPDATE' | 'DELETE' | '*'
  schema: string                    // required
  table?: string                    // omit to listen to every table in the schema
  filter?: string | RealtimePostgresFilterBuilder
  select?: string[]                 // NEW: restrict payload to these columns
}
```

So the shape you asked about is exactly:

```ts
{ event: 'INSERT', schema: 'public', table: 'x', filter: 'col=eq.1' }
```

✅ Confirmed. Your proposed payload is valid.

Full working example:

```ts
const channel = supabase
  .channel('study-sessions-changes')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'study_sessions',
      filter: 'user_id=eq.abc-123',
    },
    (payload) => {
      console.log(payload.eventType, payload.new)
    }
  )
  .subscribe((status, err) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.error(status, err)  // err.cause often holds the real reason
    }
    if (status === 'SUBSCRIBED') console.log('live')
  })

// teardown
await supabase.removeChannel(channel)      // or removeAllChannels()
```

### 4.3 Payload shape delivered to your callback

```ts
type RealtimePostgresChangesPayloadBase = {
  schema: string
  table: string
  commit_timestamp: string
  errors: string[]
}

RealtimePostgresInsertPayload<T> = Base & { eventType: 'INSERT'; new: T;      old: {} }
RealtimePostgresUpdatePayload<T> = Base & { eventType: 'UPDATE'; new: T;      old: Partial<T> }
RealtimePostgresDeletePayload<T> = Base & { eventType: 'DELETE'; new: {};      old: Partial<T> }
```

`old` is only populated if the table has `REPLICA IDENTITY FULL`:

```sql
alter table study_sessions replica identity full;
```

Without it you get the primary key only on UPDATE/DELETE. Also note: **RLS is not
applied to DELETE statements** — with RLS on and replica identity full, only the
primary key is sent to clients.

### 4.4 New in 2026: three things worth using

**(a) Column selection** — cuts payload size on wide tables:

```ts
channel.on('postgres_changes', {
  event: '*',
  schema: 'public',
  table: 'study_sessions',
  select: ['id', 'subject', 'duration_minutes'],
}, (payload) => {
  // payload.new === { id, subject, duration_minutes } only
})
```

**(b) Type-safe filter builder** — `postgresChangesFilter()` is exported from
`@supabase/supabase-js` (verified in `realtime-js/src/index.ts`):

```ts
import { postgresChangesFilter } from '@supabase/supabase-js'

// → 'quantity=gte.10,status=eq.open'
const filter = postgresChangesFilter().gte('quantity', 10).eq('status', 'open')

channel.on('postgres_changes',
  { event: 'INSERT', schema: 'public', table: 'items', filter },
  (payload) => {}
).subscribe()
```

It handles operator names, `not.` negation, AND composition, and
PostgREST-style quoting of reserved chars (`name=eq."a,b"`).

**(c) `postgres_changes_options: { wait: true }`** — hold `SUBSCRIBED` until the
server confirms the replication subscription is actually streaming. Without it,
`SUBSCRIBED` can fire before the replication slot is live, and you get a silent gap
in events.

```ts
const channel = supabase.channel('sessions', {
  config: {
    postgres_changes_options: { wait: true, timeout: 15000 }, // server clamps to ~20s
  },
})
  .on('postgres_changes', { event: '*', schema: 'public', table: 'study_sessions' }, console.log)
  .subscribe((status, err) => {
    // with wait:true, a failure here reports CHANNEL_ERROR with reasons like
    // 'PostgresChangesSubscribeTimeout: ...' or
    // 'RealtimeDisabledForConfiguration: ...' (table not in the publication)
  })
```

Setting `wait: true` auto-extends the join timeout so you don't need to pass a
larger `subscribe()` timeout. No effect on channels with no `postgres_changes`
bindings.

### 4.5 Filter operators (server-side evaluated)

A filter is a `column=operator.value` expression. Filtered-out events **never leave
the database**.

| Operator | Matches when the column… | Example |
| --- | --- | --- |
| `eq` | equals the value | `id=eq.1` |
| `neq` | does not equal the value | `status=neq.done` |
| `lt` / `lte` | is less than / ≤ | `age=lt.65` |
| `gt` / `gte` | is greater than / ≥ | `quantity=gte.10` |
| `in` | is one of a list (**max 100 values**) | `name=in.(red,blue)` |
| `like` / `ilike` | matches a pattern (case-sens / insens) | `title=like.%foo%` |
| `match` / `imatch` | matches a POSIX regex | `slug=match.^post-` |
| `is` | `IS null` / `true` / `false` / `unknown` | `deleted_at=is.null` |
| `isdistinct` | NULL-safe `!=` | `state=isdistinct.active` |

- Negate any operator with `not.` → `status=not.in.(draft,archived)`
- Combine with commas (AND) → `id=gt.0,id=lt.100`
- Syntax is strict: `room_id=eq.abc123`, **not** `room_id = abc123`

### 4.6 Enabling the table — the `supabase_realtime` publication

**Yes, you must enable it.** Realtime does not watch every table; each table must be
added to a publication named **`supabase_realtime`**. Publication name confirmed —
it has never changed.

```sql
alter publication supabase_realtime add table study_sessions;
```

Add several at once:

```sql
alter publication supabase_realtime add table study_sessions, subjects, tags;
```

Verify:

```sql
select * from pg_publication_tables where pubname = 'supabase_realtime';
```

Dashboard equivalent: **Project → Data Replication** (older docs say
"Publications"), toggle the table on under `supabase_realtime`. In a fresh Supabase
project the publication exists but with **no tables** in it.

To recreate from scratch:

```sql
begin;
drop publication if exists supabase_realtime;
create publication supabase_realtime;
commit;
alter publication supabase_realtime add table study_sessions;
```

**And you still need RLS + a SELECT policy** for the subscribing role, because
Realtime respects RLS. Without it you get zero events and no error:

```sql
alter table study_sessions enable row level security;

create policy "anon can read study_sessions"
on study_sessions for select to anon using (true);

-- also grant the privilege
grant select on study_sessions to anon;
```

- Source: <https://supabase.com/docs/guides/realtime/postgres-changes>
- Source: <https://supabase.com/docs/guides/troubleshooting/realtime-postgres-changes-troubleshooting>
- Source: <https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/realtime/postgres-changes.mdx>

### 4.7 React 19 / StrictMode cleanup

React 18+ StrictMode double-invokes effects in dev. Without cleanup you get
duplicate channels and duplicate WebSockets:

```tsx
'use client'
import { useEffect } from 'react'
import { getSupabase } from '@/lib/supabase/client'

export function useSessionChanges(onChange: (row: Session) => void) {
  useEffect(() => {
    const supabase = getSupabase()
    const channel = supabase
      .channel('session-changes')
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'study_sessions' },
          (p) => onChange(p.new))
      .subscribe()

    return () => { void supabase.removeChannel(channel) }
  }, [onChange])
}
```

---

## 5. Offline / persistence

**Be explicit: supabase-js v2 has no first-class offline persistence and no query
caching. There is none. You write your own localStorage/IndexedDB layer, or adopt a
third-party library.**

What the SDK *does* provide, and what it does **not**:

| Capability | Status |
| --- | --- |
| Auth **session** persistence | ✅ First class. `auth.persistSession` + `auth.storage` (defaults to `localStorage` in the browser, key `sb-<project-ref>-auth-token`). |
| **Your query results** persisted / cached | ❌ None. Every `.select()` hits the network. |
| Offline read of previously-fetched data | ❌ None. |
| Offline **write** queue / mutation replay | ❌ None. |
| Optimistic update helpers | ❌ None. |
| Network-failure **retries** | ✅ NEW — `db.retry` (default **true**), idempotent GET/HEAD/OPTIONS only, exponential backoff `1s → 2s → 4s`, max 3 attempts, on network errors and HTTP 503/520. Also `.retry(false)` per query. |

Retries are resilience, not offline. There is no queue; a failed `insert()` still
rejects with `status: 0`.

For the record, the long-standing upstream request for built-in caching is still
just a request: <https://github.com/supabase/supabase-js/issues/396> ("Bake caching
into supabase-js so it's performant and robust by default, ideally with optimistic
mutation support"). The team's position is that caching belongs in a separate
library so supabase-js stays small.

Third-party options (all outside the SDK, evaluate yourself):
TanStack Query + SWR, `@supabase-cache-helpers/postgrest-react-query`,
`@drakkar.software/anchor`, `tinybase-supabase`, `@zeroin.earth/supabase-query`.

For a single-user study tracker, the pragmatic answer is: **don't**. Cache in React
state, and use Realtime to keep state fresh while the tab is open. A `version`
integer on the table plus a periodic refetch is usually cheaper than a persistence
layer.

---

## 6. Error handling

### 6.1 Exact resolved shape

From `packages/core/postgrest-js/src/types/types.ts`:

```ts
interface PostgrestResponseBase {
  status: number
  statusText: string
}

export interface PostgrestResponseSuccess<T> {
  success: true
  error: null
  data: T
  count: number | null
  status: number
  statusText: string
}

export interface PostgrestResponseFailure {
  success: false
  error: PostgrestError
  data: null
  count: number | null
  status: number
  statusText: string
}

export type PostgrestSingleResponse<T>   = PostgrestResponseSuccess<T> | PostgrestResponseFailure
export type PostgrestMaybeSingleResponse<T> = PostgrestSingleResponse<T | null>
export type PostgrestResponse<T>        = PostgrestSingleResponse<T[]>
```

Destructure order in practice:

```ts
const { data, error, count, status, statusText, success } =
  await supabase.from('study_sessions').select('*')
```

Two gotchas:
1. **`success` is a real field** (new in 2026). Use it instead of `if (error)`.
2. **`statusText` may be `''`.** HTTP/2 and HTTP/3 carry no reason phrase, and all
   browser requests to Supabase are HTTP/2 or later. Branch on `status`, never on
   `statusText`.

### 6.2 What `error` actually is

**At runtime it is a plain object, not an `Error` instance.** In
`PostgrestBuilder.processResponse`:

```ts
const body = await res.text()
try {
  error = JSON.parse(body)     // <-- plain object
} catch {
  error = { message: body }     // <-- plain object
}
```

TypeScript types it as `PostgrestError`, but you get the four fields only:

```ts
{ message: string, details: string, hint: string | null, code: string }
```

`PostgrestError` (a real `class ... extends Error`) is only **thrown** when you
opt in:

```ts
const row = await supabase.from('study_sessions').select().eq('id', 1).single().throwOnError()
// throws new PostgrestError({ message, details, hint, code })
```

Consequences: `error instanceof Error` is `false`. `error.stack` is `undefined`. If
you `throw error` you throw a bare object — wrap it if you need a real `Error`.

The class is exported as a value if you need it for typing:

```ts
import { PostgrestError, type QueryError } from '@supabase/supabase-js'
// type QueryError = PostgrestError
```

### 6.3 Field-usefulness order (from the source's own docblock)

1. **`hint`** — actionable SQL. A `42501` arrives with
   `hint: "Grant the required privileges to the current role with: GRANT SELECT ON public.study_sessions TO anon;"`.
2. **`code`** — stable: PostgREST codes (`PGRST116`, `PGRST301`) or Postgres codes
   (`42501`, `23505`). Branch on this, never on message text.
3. **`details`** — often the offending value (`Key (id)=(1) already exists.`).
4. **`message`** — UI string only.

**Log the whole object.** `console.error(error.message)` throws away the hint.

### 6.4 Non-HTTP failures

```ts
// network failure
{ message: 'TypeError: Failed to fetch',
  details: <stack, or "Caused by: ..." chain>,
  hint: '', code: '' }
// status: 0, statusText: ''

// abort / timeout
{ message: 'AbortError: The user aborted a request.',
  details: '', hint: 'Request was aborted (timeout or manual cancellation)', code: '' }
// status: 0

// undici header overflow (Node)
{ hint: 'HTTP headers exceeded server limits (typically 16KB)' }
```

Also handled: a `404` whose body is a JSON array is coerced to `data: []`,
`error: null`, `status: 200` (workaround for postgrest-js#295).

### 6.5 Idiomatic handler

```ts
import type { PostgrestError } from '@supabase/supabase-js'

type Result<T> = { data: T | null; error: PostgrestError | null }

export async function handle<T>(fn: () => Promise<any>): Promise<Result<T>> {
  const { data, error } = await fn()
  if (error) {
    console.error('[supabase]', { code: error.code, message: error.message,
                                   details: error.details, hint: error.hint })
    if (error.code === 'PGRST116') return { data: null, error: null } // not-found, not a fault
    return { data: null, error }
  }
  return { data, error: null }
}
```

---

## 7. Migrations

### 7.1 Is the CLI an npm package?

**Yes.** `supabase` on npm is the current distribution channel. The npm package is a
thin shim (`bin: dist/supabase.js`) that downloads/executes the platform-specific
binary (`@supabase/cli-windows-x64`, etc.) on first run.

```bash
npm install -g supabase@latest
# or per-invocation
npx supabase@latest <command>
# or Homebrew
brew install supabase/tap/supabase
```

Verified `npx supabase@latest --version` → `2.119.0`.

### 7.2 Full command sequence: local project → existing remote project via PAT

```bash
# 0. one-time install
npm i -g supabase@latest

# 1. create the project skeleton in your repo (creates supabase/config.toml,
#    supabase/migrations/, supabase/seed.sql, .gitignore entries)
supabase init

# 2. authenticate with a Personal Access Token (no browser flow)
supabase login --token <YOUR_PERSONAL_ACCESS_TOKEN>

#    ...or skip the login step entirely in CI by exporting the env var:
#    export SUPABASE_ACCESS_TOKEN=<YOUR_PERSONAL_ACCESS_TOKEN>

# 3. write migrations
supabase migration new create_study_sessions

#    edit supabase/migrations/<timestamp>_create_study_sessions.sql

# 4. (local dev, requires Docker) test locally
supabase start
supabase migration up
#   or reapply everything from scratch:
supabase db reset

# 5. link to the remote project
supabase link --project-ref <PROJECT_REF> --password <DB_PASSWORD>
#    ...or fully non-interactive:
supabase link <PROJECT_REF> -p <DB_PASSWORD>

# 6. dry-run, then push
supabase db push --dry-run
supabase db push

# 7. bonus: generate Database types for the TypeScript client
supabase gen types typescript --project-id <PROJECT_REF> > types/database.types.ts
#    or from the linked project:
supabase gen types typescript --linked > types/database.types.ts
```

### 7.3 `supabase login --token` — **confirmed supported**

Verbatim from `supabase login --help` (CLI 2.119.0):

```
DESCRIPTION
  Authenticate using an access token.

USAGE
  supabase login [flags]

FLAGS
  --token string    Use provided token instead of automatic login flow.
  --name string     Name that will be used to store token in your settings.
  --no-browser      Do not open browser automatically.
```

So yes: `--token` for CI/headless, `--no-browser` if you want the device-code
flow without an auto-opened browser, `--name` to store multiple profiles.

`SUPABASE_ACCESS_TOKEN` is also honoured (found 15× in the shipped binary;
`SUPABASE_PERSONAL_ACCESS_TOKEN` appears 0× — the older name is **not** read).
`--profile <name>` selects a stored profile.

Create the PAT at: Dashboard → Account → **Personal Access Tokens**, or
<https://supabase.com/dashboard/account/tokens>.

### 7.4 `supabase link` — current flags

```
USAGE
  supabase link [flags] [<ref-or-branch>]

ARGUMENTS
  ref-or-branch string    Project ref, or the name (or UUID) of a branch of the
                          currently linked project. Values that are exactly 20
                          lowercase letters are always treated as project refs.

FLAGS
  --project-ref string     Project ref of the Supabase project, or the name of one of its branches.
  --password, -p string    Password to your remote Postgres database.
  --skip-pooler            Use direct connection instead of pooler.
```

Note: there is **no** `--access-token` flag on `link` any more. Authenticate
separately with `supabase login --token`, or set `SUPABASE_ACCESS_TOKEN`.
Linking writes `supabase/.temp/project-ref` (gitignored).

### 7.5 `supabase migration new` — **current**

```
USAGE
  supabase migration new [flags] <migration name>

ARGUMENTS
  migration name string    Name for the new migration file.
```

Creates `supabase/migrations/<UTC timestamp>_<migration name>.sql`.

Related commands (all current): `migration up` (apply to local), `migration list`
(divergence report), `migration repair --status applied|reverted <timestamp>`
(fix history only — does **not** run SQL), `db reset`, `db pull`, `db diff -f <name>`.

### 7.6 `supabase db push` — current flags

```
DESCRIPTION
  Push new migrations to the remote database. Vault secrets from config.toml are
  updated before migrations unless --skip-vault is set.

FLAGS
  --include-all            Include all migrations not found on remote history table.
  --include-roles          Include custom roles from supabase/roles.sql.
  --include-seed           Include seed data from your config.
  --skip-vault             Skip updating vault secrets from config.toml.
  --dry-run                Print the migrations that would be applied, but don't actually apply them.
  --db-url string          Pushes to the database specified by the connection string (must be percent-encoded).
  --linked                 Pushes to the linked project.
  --local                  Pushes to the local database.
  --project-ref string     Project ref of the Supabase project.
  --password, -p string    Password to your remote Postgres database.
```

`--dry-run` is the flag you want in CI.

### 7.7 `supabase init` — current flags

```
FLAGS
  --interactive, -i    Enables interactive mode to configure IDE settings.
  --use-orioledb       Use OrioleDB storage engine for Postgres.
  --force              Overwrite existing supabase/config.toml.
```

### 7.8 How migration history works

Supabase records applied migrations in `supabase_migrations.schema_migrations`.
`db push` diffs that against your local `supabase/migrations/` folder and applies the
missing ones in timestamp order.

**The golden rule: never change the remote database directly.** Schema changes made
in the Dashboard's SQL editor or Table Editor on a *remote* project bypass the
history table and `db push` will then fail with sync errors. Use
`supabase db pull` to capture the remote state back into a migration file.

- Source: <https://supabase.com/docs/guides/deployment/database-migrations>

### 7.9 Diff engines (2026 addition)

Which engine your project uses is decided by `config.toml`:

- `[experimental.pgdelta]` with `enabled = true` → **pg-delta**
- section missing or `enabled = false` → legacy **migra**

They differ in what `db pull` captures from managed schemas. On pg-delta a plain
`supabase db pull` picks up customizations (e.g. a trigger on `auth.users`, RLS on
`storage.objects`) automatically. Older CLIs excluded `auth`/`storage` entirely and
printed a message; if you see that, capture them explicitly:

```bash
supabase db pull --schema auth
supabase db pull --schema storage
```

- Source: <https://supabase.com/docs/guides/local-development/diff-engines>

---

## 8. Version constraints & known incompatibilities

### 8.1 Node.js

`@supabase/supabase-js@2.117.2` declares:

```json
{ "engines": { "node": ">=22.0.0" } }
```

And `src/index.ts` carries a runtime warning:

```ts
if (shouldShowDeprecationWarning()) {          // true when process.version major <= 20,
  console.warn(                                 // and not browser/Deno
    `⚠️  Node.js 20 and below are deprecated and will no longer be supported in ` +
    `future versions of @supabase/supabase-js. Please upgrade to Node.js 22 or later. ` +
    `For more information, visit: https://github.com/orgs/supabase/discussions/45715`
  )
}
```

EOL history:
- Node 18 EOL 2025-04-30 → support dropped in **2.79.0** (last good: `2.78.0`)
- Node 20 EOL 2026-04-30 → support dropped in **2.110.0** (last good: `2.109.0`)

Practical impact: `engines` is advisory in npm — you get `EBADENGINE` as a
**warning**, not a failure, unless `engine-strict=true` in `.npmrc`. Browsers are
unaffected (bundlers don't enforce `engines` for browser targets). Treat **Node 22
LTS as the floor** for the CLI and for Next's server runtime.

### 8.2 TypeScript

`@supabase/supabase-js` will **require TypeScript 5.0+ starting 2027-01-31**;
support for TS 4.7–4.9 is being dropped. Upgrade now — you're on 7.0.2.
- Source: <https://supabase.com/changelog/47812-deprecation-notice-supabase-supabase-js-will-require-typescript-5-0>

### 8.3 Next.js 16 — `middleware.ts` is dead, use `proxy.ts`

**This is the single biggest footgun in 2026.** Next 16 (2025-10-21) renamed the
file convention:

```diff
// middleware.ts -> proxy.ts

- export function middleware(request: NextRequest) {
+ export function proxy(request: NextRequest) {
```

```bash
npx @next/codemod@canary middleware-to-proxy .
# or the broader:
npx @next/codemod@canary upgrade latest
```

Consequences:
- A leftover `middleware.ts` is **silently ignored at build time**. No error. Your
  auth redirects just stop running and protected routes become publicly reachable.
  Search your repo for stray middleware files after upgrading.
- Config flag `skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`.
- Proxy runs on the **Node.js runtime only** (not configurable). `middleware.ts`
  survives for Edge-runtime users but is deprecated and slated for removal.
- `ProxyRequest` / `ProxyResponse` are exported from `next/proxy`; `NextRequest` /
  `NextResponse` still work from `next/server`.
- Next docs state proxy is **not** a session-management or authorization boundary —
  use it for optimistic checks; enforce authorization in the data layer (RLS).

Other Next 16 breaking changes relevant here:
- **Async-only request APIs.** `cookies()`, `headers()`, `draftMode()`, `params`,
  `searchParams` all return Promises. Sync access throws at runtime.
- Turbopack is the default bundler (`--webpack` to opt out).
- Cache Components / `'use cache'` replaces implicit fetch caching and
  `unstable_cache`.
- `revalidateTag(tag)` single-arg deprecated → `revalidateTag(tag, profile)` or
  `updateTag(tag)`.

```bash
npx @next/codemod@latest async-request-apis
```

- Source: <https://nextjs.org/blog/next-16>
- Source: <https://nextjs.org/docs/app/api-reference/file-conventions/proxy>
- Source: <https://supabase.com/docs/guides/auth/server-side/creating-a-client>

The Supabase docs state the failure mode explicitly:

> On Next.js 15 and earlier, a `proxy.ts` file is never called, so sessions never
> refresh and users get signed out.

(Moot for you — no auth — but it tells you how sharp this edge is.)

### 8.4 React 19

- supabase-js has **no React peer dependency** — it is framework-agnostic.
- **StrictMode double-invokes effects in dev.** Any `useEffect` that calls
  `.subscribe()` must return a `removeChannel` cleanup or you leak channels and
  WebSockets on every hot reload. See §4.7.
- `useEffectEvent`, `use`, and Actions are all React 19 surfaces supabase-js does
  not interact with.

### 8.5 Known-harmless build warning

Vite / Rollup / Nuxt emit:

```
"PostgrestError" is imported from external module "@supabase/postgrest-js" but never used in "...supabase-js/dist/index.mjs".
"FunctionRegion", "FunctionsError", ... is imported from external module "@supabase/functions-js" but never used in "...".
```

**False positive.** supabase-js re-exports these so *you* can import them; the build
merges same-package imports into one statement and the bundler doesn't count an
`export` as usage. Bundle size and tree-shaking are unaffected. Suppress with:

```js
// vite.config.js / rollup.config.js
export default {
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'UNUSED_EXTERNAL_IMPORT' && warning.exporter?.includes('@supabase/'))
          return
        warn(warning)
      },
    },
  },
}
```

- Source: supabase-js `README.md` → "Known Build Warnings"

### 8.6 `@supabase/ssr` quirks (N/A if you skip it, but for the record)

- Forces `flowType: 'pkce'`.
- **Ignores `auth.storage`** — session always goes to cookies; passing it logs a
  one-time warning.
- `cookies.get` / `set` / `remove` are deprecated; use `getAll` / `setAll`.
- Peer requires `@supabase/supabase-js ^2.114.0` — it is pinned to a recent v2.
- Server components can't write cookies, so `setAll` there must be wrapped in
  try/catch and the error swallowed; the proxy layer does the actual cookie writing.
- Never mix with `@supabase/auth-helpers-nextjs` (deprecated → `@supabase/ssr`).

---

## 9. Copy-paste starter

```ts
// types/database.types.ts  <- generated by: supabase gen types typescript --linked > types/database.types.ts
export type Database = { /* ... */ }

// lib/supabase/client.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

let cached: SupabaseClient<Database> | undefined

export function getSupabase(): SupabaseClient<Database> {
  if (!cached) {
    cached = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { db: { retry: true } },
    )
  }
  return cached
}

// lib/supabase/queries.ts
import { getSupabase } from './client'

export type SessionRow = {
  id: string
  subject: string
  duration_minutes: number
  completed: boolean
}

export async function listSessions(limit = 50) {
  const { data, error, status } = await getSupabase()
    .from('study_sessions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[supabase]', { status, ...error })  // log the whole object
    throw error
  }
  return data as SessionRow[]
}

export async function getSession(id: string) {
  const { data, error } = await getSupabase()
    .from('study_sessions')
    .select('*')
    .eq('id', id)
    .maybeSingle()                                   // 0 rows -> null, no error

  if (error) throw error
  return data as SessionRow | null
}

export async function saveSession(row: Partial<SessionRow> & { id?: string }) {
  const supabase = getSupabase()
  const q = row.id
    ? supabase.from('study_sessions').upsert(row as any, { onConflict: 'id' })
    : supabase.from('study_sessions').insert(row as any)

  const { data, error } = await q.select().single()  // 0 rows -> PGRST116
  if (error) throw error
  return data as SessionRow
}

// components/useSessions.ts
'use client'
import { useCallback, useEffect, useState } from 'react'
import { getSupabase } from '@/lib/supabase/client'
import type { SessionRow } from '@/lib/supabase/queries'

export function useSessions(onLoad: () => Promise<SessionRow[]>) {
  const [rows, setRows] = useState<SessionRow[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const r = await onLoad()
    setRows(r)
  }, [onLoad])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => {
    const supabase = getSupabase()
    const channel = supabase
      .channel('study-sessions-changes')
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'study_sessions' },
          () => { void reload() })
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error(status, err)
          setError('Realtime connection failed')
        }
      })
    return () => { void supabase.removeChannel(channel) }   // required: StrictMode
  }, [reload])

  return { rows, error, reload }
}
```

SQL bootstrap — **do not forget the publication line**, it is the #1 reason
Realtime silently does nothing:

```sql
create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  completed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.study_sessions enable row level security;

grant select, insert, update, delete on public.study_sessions to anon;

create policy "anon full access to study_sessions"
on public.study_sessions for all to anon using (true) with check (true);

-- REQUIRED for Realtime to see the table:
alter publication supabase_realtime add table public.study_sessions;
```

---

## Unverified / flagged

1. **`.single()` message wording may shift.** PostgREST PR #3795
   ("fix: clarify PGRST116 error message") proposes changing
   `message` from `"JSON object requested, multiple (or no) rows returned"` to
   `"Cannot coerce the result to a single JSON object"`, keeping
   `details: "The result contains 0 rows"`. **Branch on `code === 'PGRST116'`, never
   on message text.** I did not verify whether that PR has shipped to the PostgREST
   version your project runs.
   - <https://github.com/PostgREST/postgrest/pull/3795>

2. **`select` column filter + `postgres_changes_options.wait` server support.**
   These are in the JS client types and docs, but they require Realtime server
   support. I did not verify which Realtime server version each feature landed in or
   whether older self-hosted instances accept them. Safest: use `.select()` to verify
   at runtime, or pin to hosted Supabase.

3. **`PostgREST 13` for `maxAffected()`** — the SDK gates it on
   `ClientOptions['PostgrestVersion']` and defaults to `'12'`. It type-errors
   against a v12 client. Not usable unless your project is on PostgREST 13.

4. **`pg-delta` diff-engine defaults for new projects.** The docs say the engine is
   chosen by `config.toml`, but `supabase init` does not appear to write an
   `[experimental.pgdelta]` section by default (I did not verify the shipped
   `config.toml` template). Check your generated file before relying on pg-delta
   behaviour.

5. **PostgREST server versions per project.** I documented `stripNulls` (11.2+),
   `maxAffected` (13+) from the SDK's own gates. I did not verify which version your
   specific hosted project is on — check Dashboard → Data API → settings.

6. **Version numbers drift.** 2.117.2 / 0.12.7 / 2.119.0 / 16.3.8 were live at the
   time of research (2026-10-01). Supabase ships very frequently — the last 7 days
   included 409 releases. Re-run the `npm view` commands in §0 to re-verify.

7. **I could not reach `supabase.com/docs/reference/javascript/initializing`** —
   that page exceeds the 5 MB fetch limit, so the `createClient` facts in §2 come
   from the **source on `master`** rather than the rendered reference page. The two
   agree; source is authoritative for the signature.

---

## Citation index

- API keys / migration: <https://supabase.com/docs/guides/getting-started/api-keys>,
  <https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys>
- Node/TS deprecations: <https://github.com/supabase/supabase-js/blob/master/packages/core/supabase-js/README.md>,
  <https://supabase.com/changelog/47812-deprecation-notice-supabase-supabase-js-will-require-typescript-5-0>
- Key-format fix: <https://github.com/supabase/supabase-js/pull/2526>
- Source: <https://github.com/supabase/supabase-js/tree/master/packages/core>
- `@supabase/ssr`: <https://github.com/supabase/ssr/blob/main/src/createBrowserClient.ts>,
  <https://cdn.jsdelivr.net/npm/@supabase/ssr@0.12.7/README.md>
- SSR guide: <https://supabase.com/docs/guides/auth/server-side/creating-a-client>
- Realtime: <https://supabase.com/docs/guides/realtime/postgres-changes>,
  <https://supabase.com/docs/guides/realtime/subscribing-to-database-changes>,
  <https://supabase.com/docs/guides/troubleshooting/realtime-postgres-changes-troubleshooting>
- Migrations: <https://supabase.com/docs/guides/deployment/database-migrations>
- Diff engines: <https://supabase.com/docs/guides/local-development/diff-engines>
- Next 16: <https://nextjs.org/blog/next-16>,
  <https://nextjs.org/docs/app/api-reference/file-conventions/proxy>,
  <https://nextjs.org/docs/messages/middleware-to-proxy>
- Caching (still absent): <https://github.com/supabase/supabase-js/issues/396>
