# Analytics DB: materialized-view refresh (Phase 6, the DB side)

**Audience: ops/DBA with admin on the analytics Postgres server**
(`bloom-analytics.postgres.database.azure.com`, Azure Database for PostgreSQL). Contact:
andrew_polk@sil.org.

> **Status (2026-07-22): LIVE — cutover complete.** pg_cron is enabled, the
> `refresh-materialized-views` job is scheduled and has fired successfully, the read-only user reads
> run history through `common.mv_refresh_status()` (SECURITY DEFINER — see step 3), the GHA watchdog
> passes against it (run on commit `dcabbd5`), and the old Azure `dailyTimer` has been **disabled**
> (via the Azure portal, 2026-07-22). The steps below are the version-controlled record of that
> setup and the reference for rebuilding it. Rollback path if the refresh ever regresses: see
> Cutover.

## What this is and why

Phase 6 of the Azure→Supabase migration ([`../FUNCTIONS-MIGRATION-PLAN.md`](../FUNCTIONS-MIGRATION-PLAN.md),
Phase 6) retires the Azure `dailyTimer`. Its only job was calling
`common.refresh_materialized_views()` in this analytics DB once a day. Since that's a
database-talking-to-itself operation, we do **not** port a function — we schedule the refresh
*inside* Postgres with **pg_cron**, and this repo carries only an external **freshness watchdog**
([`../.github/workflows/cron-analytics-freshness-watchdog.yml`](../.github/workflows/cron-analytics-freshness-watchdog.yml))
that emails us if a refresh fails or never fires.

This file is the **DB side** (Part A) — the pg_cron setup and grants that must exist for the
watchdog to work. The steps below run against the analytics DB, not this Supabase repo; the SQL is
kept here as the version-controlled reference. The `common.refresh_materialized_views()` procedure
itself already lives in the analytics DB (source in the separate `analytics-postgreSQL` repo).

## 1. Enable pg_cron (one-time; requires a server restart)

On the Azure Postgres server parameters (portal → Server parameters, or `az postgres flexible-server parameter set`):

1. Add `pg_cron` to **`shared_preload_libraries`** (comma-separated allowlist).
2. Add `pg_cron` to **`azure.extensions`**.
3. Set **`cron.database_name`** to the analytics database (the DB that owns
   `common.refresh_materialized_views()`). pg_cron's own tables (`cron.job`,
   `cron.job_run_details`) live in this database.
4. **Restart the server** — the `shared_preload_libraries` change needs it. This is the one risky
   step; the failure mode is stale stats (detectable, recoverable), never data loss.
5. Connected to that database as the admin role:
   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_cron;
   ```

## 2. Schedule the refresh + a prune job

Run as the admin role, connected to the database named in `cron.database_name`:

```sql
-- The daily materialized-view refresh (replaces the Azure dailyTimer).
-- IMPORTANT: pg_cron evaluates cron expressions in UTC. The Azure timer ran at 10:40 -- confirm
-- whether that was UTC and convert if not, so the refresh lands at the same wall-clock time.
SELECT cron.schedule(
  'refresh-materialized-views',           -- job name the watchdog looks for; do not rename
  '40 10 * * *',
  $$ CALL common.refresh_materialized_views() $$   -- it's a PROCEDURE, so CALL (not SELECT)
);

-- Keep pg_cron's run history (which the watchdog reads) from growing without bound.
SELECT cron.schedule(
  'prune-cron-history',
  '0 3 * * *',
  $$ DELETE FROM cron.job_run_details WHERE end_time < now() - interval '30 days' $$
);
```

Notes:
- If `cron.database_name` cannot be pointed at the analytics DB, use
  `cron.schedule_in_database('refresh-materialized-views','40 10 * * *', $$ ... $$, '<analytics_db>')`
  instead so the command runs in the right database.
- The job name **`refresh-materialized-views`** is a contract with the watchdog
  (`WHERE j.jobname = 'refresh-materialized-views'`). If you change it, change the workflow too.

Confirm it registered:
```sql
SELECT jobid, jobname, schedule, active FROM cron.job;
```

## 3. Grant the read-only user access to the run history

The watchdog connects as the existing **read-only** analytics user (the one behind
`BLOOM_ANALYTICS_READONLY_URL` in the GitHub repo secrets). It needs to read pg_cron's run
history:

```sql
GRANT USAGE ON SCHEMA cron TO <readonly_user>;
GRANT SELECT ON cron.job, cron.job_run_details TO <readonly_user>;
```

> ⚠️ **Visibility caveat (this WILL bite — expose a function, not the tables).** pg_cron enforces
> row-level security with the policy `username = current_user`, so a **non-superuser sees only its
> own jobs**. The read-only user is not the job owner, so the `GRANT SELECT` above returns **zero
> rows** for the admin-owned `refresh-materialized-views` job. A plain **view does NOT fix this** —
> `current_user` in the policy still resolves to the invoking (read-only) user through a view, so it
> too returns zero rows. (Verified empirically on PostgreSQL 17.10 / Azure Flexible Server: the
> admin role `silpgadmin` does not bypass RLS, so the view-owner trick has nothing to resolve.)
>
> The fix that works is an admin-owned **`SECURITY DEFINER` function** — it executes as its owner, so
> `current_user` becomes the admin and the policy matches. Create it as the role that owns the job
> (the `username` in `cron.job`, e.g. `silpgadmin`):
> ```sql
> CREATE OR REPLACE FUNCTION common.mv_refresh_status()
> RETURNS TABLE(status text, start_time timestamptz, end_time timestamptz, return_message text)
> LANGUAGE sql SECURITY DEFINER AS $$
>   SELECT d.status, d.start_time, d.end_time, d.return_message
>   FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
>   WHERE j.jobname = 'refresh-materialized-views';
> $$;
> ALTER FUNCTION common.mv_refresh_status() OWNER TO <admin_role>;   -- must equal cron.job.username
> GRANT USAGE ON SCHEMA common TO <readonly_user>;
> GRANT EXECUTE ON FUNCTION common.mv_refresh_status() TO <readonly_user>;
> ```
> Verify as the read-only user (note the **parentheses** — it's a function, not a view):
> ```sql
> SELECT * FROM common.mv_refresh_status() ORDER BY start_time DESC LIMIT 1;
> ```
> The watchdog workflow already reads `common.mv_refresh_status()`. If you created a plain
> `common.mv_refresh_status` **view** during earlier troubleshooting, `DROP VIEW` it — it returns
> zero rows for the read-only user and only causes confusion.

## 4. Cutover

1. Do steps 1–3, then let the refresh fire once (or run
   `CALL common.refresh_materialized_views();` manually) and confirm a `succeeded` row:
   ```sql
   SELECT status, start_time, end_time, return_message
   FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
   WHERE j.jobname = 'refresh-materialized-views' ORDER BY start_time DESC LIMIT 3;
   ```
2. Add the `BLOOM_ANALYTICS_READONLY_URL` GitHub repo secret and let the watchdog run (it can be
   triggered manually via **Run workflow**). It should go green.
3. **Disable the Azure `dailyTimer`** once pg_cron has refreshed cleanly for a day or two.
   ✅ Done 2026-07-22 (disabled via the Azure portal UI).

**Rollback** (if the pg_cron refresh ever regresses): re-enable the Azure `dailyTimer` and
`SELECT cron.unschedule('refresh-materialized-views');`.
