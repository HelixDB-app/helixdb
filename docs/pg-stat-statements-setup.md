# pg_stat_statements setup guide

pgStudio’s **Query History → pg_stat_statements** view needs PostgreSQL to expose the `pg_stat_statements` extension **and** load the `pg_stat_statements` **shared library at server startup**. If either piece is missing, the app shows a setup banner instead of live statement stats.

## Why it fails (common cases)

| Symptom | Meaning |
|--------|---------|
| “Extension already exists” but no data | `CREATE EXTENSION` ran, but `shared_preload_libraries` does not include `pg_stat_statements`, or the server was not restarted after changing it. |
| Cannot query `pg_stat_statements` | Same as above, or insufficient privileges on the view. |
| Works on local, fails on cloud | Managed services often start with an empty `shared_preload_libraries`; you must set it in the provider’s **server parameters** and restart (or wait for maintenance window), then run `CREATE EXTENSION` in each database that needs stats. |

## Required steps (all environments)

1. **Preload** — Ensure `shared_preload_libraries` contains `pg_stat_statements` (comma-separated with any existing libraries, e.g. `$libdir/other_ext, pg_stat_statements`).
2. **Restart** — Restart the PostgreSQL **process** (or failover/reboot on managed offerings) so the preload takes effect.
3. **Extension** — In each database: `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` (pgStudio’s **Run CREATE EXTENSION** button does this.)

Optional tuning (after it works): `pg_stat_statements.max`, `track_io_timing`, etc. See [PostgreSQL documentation](https://www.postgresql.org/docs/current/pgstatstatements.html).

---

## Local PostgreSQL (macOS / Linux)

1. Edit `postgresql.conf` (path often shown in pgStudio’s setup panel as **Config file**, or run `SHOW config_file;`).
2. Set or merge:

   ```ini
   shared_preload_libraries = 'pg_stat_statements'
   ```

   If you already have other libraries, append with a comma (no spaces required, but spaces after commas are fine).

3. Restart PostgreSQL (e.g. `brew services restart postgresql@16`, `sudo systemctl restart postgresql`, or your installer’s control panel).
4. Connect to the target database and run:

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```

---

## Docker

In `docker-compose.yml` or `docker run`, pass a custom `command` or mount a config that sets preload, for example:

```yaml
command:
  - "postgres"
  - "-c"
  - "shared_preload_libraries=pg_stat_statements"
```

Or use a mounted `postgresql.conf`. **Recreate** the container after changing startup parameters.

Then run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` in each database.

---

## Azure Database for PostgreSQL — Flexible Server

Azure does not give you direct `postgresql.conf` file access; use **Server parameters** in the Azure portal (or Azure CLI / ARM).

1. In the [Azure portal](https://portal.azure.com), open your **Flexible Server** resource.
2. Go to **Settings → Server parameters**.
3. Search for **`shared_preload_libraries`**.
4. Set the value to include **`pg_stat_statements`**, preserving any existing entries Azure requires (merge comma-separated). Example pattern:

   `pg_cron,pg_stat_statements`

   (Your server may list different libraries; **append** `pg_stat_statements` rather than replacing the whole string unless documentation says otherwise.)

5. **Save**. If the portal indicates a **restart** is required, restart the flexible server (or schedule maintenance).
6. Connect with a role that can create extensions (often the admin user created with the server).
7. Run:

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```

If creation fails with a message about preload, the server parameter did not apply yet or the value was overwritten—recheck **Server parameters** and restart.

Also confirm **`azure.extensions`** (or your server’s allowlist) permits `PG_STAT_STATEMENTS` where applicable; Flexible Server generally supports this extension when preload is configured.

---

## Amazon RDS for PostgreSQL

Use a **DB parameter group**: set `shared_preload_libraries` to include `pg_stat_statements` (merge with existing values), apply the group to the instance, then **reboot** the DB instance. After reboot, run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` in the database.

---

## Verify

```sql
SHOW shared_preload_libraries;
SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements';
SELECT count(*) FROM pg_stat_statements;
```

If the last query succeeds, pgStudio’s pg_stat_statements mode should load after a refresh (or reconnect).

---

## Security note

`pg_stat_statements` records normalized query text. Restrict who can read `pg_stat_statements` / `pg_stat_statements_info` on production systems if queries may contain sensitive literals (prefer bind parameters).
