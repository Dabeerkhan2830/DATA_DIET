# DataDiet Setup (Windows PowerShell)

All commands are PowerShell and assume the repository is at
`C:\Users\yadav\Desktop\DataDiet`. Adjust the path if you cloned it elsewhere.

## Prerequisites

| Tool | Version used for Phase 1 | Notes |
| --- | --- | --- |
| Node.js | 24.13.1 | includes npm 11.8 |
| Python | 3.14.1 | any 3.11+ should work |
| Git | 2.55 | |
| Docker Desktop | optional | needed only for MySQL and the Nginx preview |

Docker is **not** required to run the frontend, the backend health endpoint, or
the synthetic demo endpoints that power the Phase 1 UI.

## 1. Configure environment

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet
Copy-Item .env.example .env
```

`.env` is git-ignored. Never commit real credentials. The default development
values match `infra/docker-compose.dev.yml`.

`CORS_ORIGINS` accepts either a comma-separated list or a JSON array
(`backend/app/core/config.py`, ADR-0021); the comma form is the portable one for
deployed platforms, whose application settings can only hold flat strings.
`LOCAL_SOURCE_ROOTS` is a dict field and must therefore stay JSON.
`API_HOST`/`API_PORT`/`MYSQL_*` are not read by the application — see
`docs/azure-architecture.md` section 5 for the complete list of keys the code
actually consumes and where each comes from in a deployed environment.

## 2. Backend (FastAPI)

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet

# Create the virtual environment (once)
python -m venv .venv

# Install dependencies
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt

# Run the API (from the backend directory so app.* imports resolve)
Set-Location backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- API root: http://127.0.0.1:8000/
- Swagger UI (API documentation): http://127.0.0.1:8000/docs
- Liveness: http://127.0.0.1:8000/api/v1/health
- Readiness (database probe): http://127.0.0.1:8000/api/v1/health/ready

`/api/v1/health/ready` returns HTTP 503 with `"status": "degraded"` until MySQL
is running — that is expected behaviour, not a crash.

## 3. Frontend (React + Vite)

In a second PowerShell window:

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\frontend
npm install
npm run dev
```

Open http://localhost:5173. The dev server proxies `/api` to
`http://localhost:8000`, so leave `VITE_API_BASE_URL` empty in `.env`.

## 4. Database (MySQL or PostgreSQL, optional in Phase 1)

Requires Docker Desktop:

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet
docker compose -f infra/docker-compose.dev.yml up -d mysql
docker compose -f infra/docker-compose.dev.yml ps   # wait for "healthy"

# Apply migrations
Set-Location backend
..\.venv\Scripts\alembic.exe upgrade head
..\.venv\Scripts\alembic.exe current
```

Expected result: `0014_external_identities` (the single head). Without Docker,
skip this section — the application still runs and reports the database as
unreachable.

**PostgreSQL (ADR-0025).** `DATABASE_URL` accepts
`postgresql+psycopg2://user:password@host:5432/dbname` as well as the MySQL URL
above. A *fresh* PostgreSQL database does not replay `0001`–`0012` — that history
is MySQL-shaped and PostgreSQL rejects parts of it — it enters at the `0013`
baseline instead:

```powershell
Set-Location backend
..\.venv\Scripts\python.exe ..\scripts\migration_preflight.py   # read-only; confirms dialect + pending
..\.venv\Scripts\alembic.exe stamp 0012_audit_platform_admin_reset
..\.venv\Scripts\alembic.exe upgrade head
..\.venv\Scripts\alembic.exe current
```

Never stamp or upgrade a database that already has tables: `stamp` only writes the
revision row. An existing MySQL database needs nothing new — `0013` detects the
dialect and does nothing, so `upgrade head` there applies only
`0014_external_identities`. `0013_postgresql_baseline` is forward-only: its
downgrade refuses to run rather than drop a baseline. The development/test helper
`pgserver` starts a disposable local PostgreSQL for
`tests/test_migrations_postgresql.py`; it is in `requirements-dev.txt` only, and
those tests skip with a stated reason when it is unavailable. SQLite is not a
supported target and is never used as evidence of PostgreSQL behaviour.

Supported rollback boundary: **`0005_source_connectors`** — do not
`alembic downgrade` below it (ADR-0016 explains the safe failure mode and the
repair procedure if you do). The boundary is MySQL-only: on PostgreSQL nothing
below `0013_postgresql_baseline` can be reversed (ADR-0025).

Applying migrations to an **existing** database is a privileged operation —
especially `0011`, which resets every platform-admin flag. Follow the migration
runbook in section 8 instead of running `upgrade head` directly, and take a
test-restored backup first (`docs/backup-restore.md`).

## 5. Signing in (Phase 7; Clerk added in Phase 6.0)

Every endpoint except `/api/v1/health` and `/api/v1/auth/config` requires a
signed bearer token (ADR-0014). How you get one depends on the deployment, and
`GET /api/v1/auth/config` reports which mode this deployment actually is in — the
sign-in page never offers a credential path the server would refuse:

- **Clerk (the staging/production path, ADR-0025):** when `CLERK_ISSUER` is set,
  session tokens are RS256 and are verified against Clerk's published JWKS. The
  frontend renders Clerk's own sign-in component (it must be built with
  `VITE_CLERK_PUBLISHABLE_KEY`; see `.env.example`) and sends a Clerk session
  token per request; DataDiet stores no password and no copy of that token.
  A Clerk identity grants nothing until an operator binds it to an account:
  `python ..\scripts\bind_clerk_identity.py bind --subject <clerk user id> --email
  <account email> --actor "ops:your-name"`. An unbound identity is refused with
  `unknown_account`, and the page shows that refusal rather than a session.
- **Development (default, local only):** open http://localhost:5173 and use the
  *Development sign-in* form on `/signin`. It calls `POST /api/v1/auth/dev-login`,
  which creates/reuses a synthetic local account and issues a real HS256 token
  through the same verification path as every other token. This is explicitly
  **not** production authentication. In `ENVIRONMENT=staging|production` the
  route is not registered at all, so it answers 404 and is absent from the OpenAPI
  schema; the handler additionally refuses with 503 `sign_in_unavailable:` if it
  is ever reached, and it refuses the same way whenever `CLERK_ISSUER` is
  configured — Clerk always wins.
- **Bearer boundary:** paste an externally issued token (HS256, your
  `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE` claims, a `sub` or `email` matching a
  local account). Available when no identity provider is configured and a real
  signing secret exists.
- **Unconfigured:** the page says authentication is not configured instead of
  showing a form. In a protected environment this is the state until an operator
  configures Clerk or sets a real `AUTH_JWT_SECRET` — every protected endpoint
  then returns 503 `auth_not_configured:` (fail closed by design).

Create the first platform administrator offline (there is no HTTP bootstrap):

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\backend
..\.venv\Scripts\python.exe ..\scripts\bootstrap_admin.py --email admin@example.org --institution-id 1 --role admin --actor "ops:your-name"
```

The same command is the audited recovery path after migration `0011` resets
existing platform-admin flags (see section 8.4). It promotes exactly the named
account and never mass-grants. Under Clerk the order matters: create and configure
the account first, then bind its Clerk subject — binding grants nothing, and no
HTTP route can create an account or grant `platform_admin`.

Authorization (roles, institution scope) always comes from the local user
directory, never from token claims and never from identity-provider metadata.
Sign-out is client-side: the token is discarded from `localStorage` (bearer tokens
are stateless; there is no logout endpoint), and when Clerk is mounted the
provider's own browser session is ended through Clerk's supported sign-out.

## 6. Run the checks

Backend:

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\backend
..\.venv\Scripts\python.exe -m pytest              # 360 tests; 20 skip without a live MySQL
..\.venv\Scripts\python.exe -m ruff check .         # backend lint
..\.venv\Scripts\python.exe -m ruff check ..\scripts  # operator scripts (same Ruff config)

# The 19 MySQL migration tests run only with an explicitly opted-in,
# disposable loopback database. The guard refuses production-like names,
# non-loopback hosts, and any target equal to DATABASE_URL:
# $env:MIGRATION_TEST_ALLOW_DROP = "1"
# $env:MIGRATION_TEST_DB_URL = "mysql+pymysql://root:@127.0.0.1:3307/datadiet_mig"
# ..\.venv\Scripts\python.exe -m pytest tests/test_migrations_mysql.py     # 19 tests

# The PostgreSQL migration tests need no server and no opt-in: they start a
# disposable instance through the `pgserver` dev dependency (loopback only) and
# skip with a stated reason if it is not installed. Never a substitute for the
# MySQL suite, and SQLite is never treated as evidence of PostgreSQL behaviour.
# ..\.venv\Scripts\python.exe -m pytest tests/test_migrations_postgresql.py  # 10 tests
```

Frontend:

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\frontend
npm run typecheck     # tsc strict, no emit
npm test              # vitest run — 507 tests in 32 files
npm run build         # production bundle into dist/
```

`npm test` pins `--pool=forks --poolOptions.forks.maxForks=4`, and the pin is
part of the gate, not a preference. Measured on 2026-11-04 with the full 507-test
suite: the stable configuration passes 507/507 (exit 0) reproducibly, while
Vitest's default pool fails a shifting set of 5–6 tests (exit 1) with `Test
timed out in 5000ms` and Testing Library's 1 s `findBy` timeouts — the machine is
oversubscribed by one fork per core while jsdom and `userEvent` still need the
event loop. Same tests, same code, different worker count. The assertion timeout
was **not** raised and no test was skipped or reordered: the fix is the worker
count. If a future suite still cannot run four forks without contention, lower
`maxForks` rather than lengthening timeouts.

Everything from the repository root:

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet
.\scripts\check.ps1
```

### Continuous integration

`.github/workflows/ci.yml` is configured to run on every pull request and every
push to `main` on a GitHub-hosted Ubuntu runner. It installs
`backend/requirements-dev.txt`
and the frontend lockfile (`npm ci`), then runs:

- backend Ruff and operator-script Ruff (`migration_preflight.py`,
  `bootstrap_admin.py`) with `backend/pyproject.toml`;
- the backend pytest suite;
- the 19 live MySQL migration tests against an ephemeral `mysql:8.4` service
  (`MIGRATION_TEST_DB_URL` and `MIGRATION_TEST_ALLOW_DROP=1` are set only for
  that step; the test guard also enforces a loopback host and a
  `datadiet_(mig|test|ci)` database name);
- frontend type checking, Vitest, and the production build.

The workflow uses no repository secret or production credential. Its job stops
at the first failing step. The MySQL step fails if `MIGRATION_TEST_DB_URL` is
missing and asserts that exactly 19 tests pass, so it cannot silently succeed
with every test skipped. GitHub Actions (`checkout`, `setup-python`, `setup-node`)
are pinned to full commit SHAs with release comments, and the MySQL image is
pinned to a verified multi-arch digest.

CI is the Linux equivalent of `scripts/check.ps1`, which remains the local
Windows PowerShell 5.1 gate; the script is not invoked in CI because it uses
Windows virtual-environment paths. The Windows-only symlink test is expected to
execute (not skip) on Linux. Python dependencies are still range-pinned (`>=`)
with no lockfile, so CI resolves the versions in `requirements-dev.txt`; a
lockfile has not been generated because it cannot be validated for this
project's supported platforms in the current environment. The frontend is
reproducible through `package-lock.json`. The workflow file is YAML-parsed and
its local equivalents were run, but the GitHub-hosted Linux job and its
`mysql:8.4` service have not run; Docker is not installed in this development
environment. Remote execution requires a push or pull request.

Production blockers are tracked in `docs/production-readiness.md`. Backups and
restore drills are in `docs/backup-restore.md`. The prepared-but-undeployed
Render staging runbook (Clerk configuration, PostgreSQL entry path, secret
placement, human-triggered migrations, privacy options and its validation gate)
is `docs/render-staging.md`.

A second workflow, `.github/workflows/azure-deploy.yml`, is scaffolding for a
future Azure deployment. It is deliberately not part of this developer loop: it
triggers only on `workflow_dispatch`, needs Azure-side configuration (OIDC
federation plus per-environment variables) that does not exist yet, validates
the Bicep templates offline, separates build from deploy, requires a protected
GitHub environment for production, runs read-only smoke checks only, and never
runs Alembic. It has never executed and its actions are pinned to version tags
rather than commit SHAs, which does **not** meet the convention described above
(ADR-0019) and must be fixed before it is enabled. See
`docs/azure-deployment.md` section 1.2 for what it needs, and
`docs/azure-architecture.md` section 1.3 for the blockers.

## 7. Creating a new migration

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\backend
# 1. Edit app\db\models.py
# 2. Autogenerate a revision against the running dev database
..\.venv\Scripts\alembic.exe revision --autogenerate -m "add example column"
# 3. Review the generated file in ..\database\migrations\versions\
..\.venv\Scripts\alembic.exe upgrade head
```

Never hand-edit production tables; models change first, then migrations.

## 8. Migration runbook (existing databases)

Migration `0011_platform_admin_default_false` is a security correction: it
changes the `app_users.is_platform_admin` default to false **and resets the flag
on every existing account** (ADR-0017). Forward migration
`0012_audit_platform_admin_reset` then appends an idempotent audit event with the
post-reset administrator count; it changes no account or privilege (ADR-0020).
Treat applying them as a privileged change, not a routine startup step.

Supported engines: **MySQL 8.x** and **PostgreSQL** (ADR-0025). The development
compose file pins `mysql:8.4`. The live migration suite passed 19/19 on MySQL
8.0.46 locally; CI is configured to use `mysql:8.4` but has not run on GitHub.
The PostgreSQL chain is exercised by `tests/test_migrations_postgresql.py`
against a real `pgserver` instance (10 tests), not by the MySQL suite and not by
SQLite. A database on either engine enters the history at its own revision:
PostgreSQL needs the `0013_postgresql_baseline` entry path in section 4 (stamp
`0012_audit_platform_admin_reset`, then `upgrade head`) because `0001`–`0012`
cannot be replayed there, and `0013` is a no-op on MySQL. The preflight reports
the dialect and rejects any other engine with exit code 6.

### 8.1 Preflight (read-only)

From `backend/`, with the intended `DATABASE_URL` / `.env` configured:

```powershell
..\.venv\Scripts\python.exe ..\scripts\migration_preflight.py
```

It prints the environment, a **credential-free** target
(`driver://host:port/database` — no user, password, or query parameters), the
revision stamped in the database, the repository head and the pending
revisions. It never applies anything.

Exit codes: `0` expected state (at head, or on-chain with pending migrations);
`1` unexpected internal error; `2` database unreachable or URL unusable; `3`
not under Alembic control (`alembic_version` missing, empty or ambiguous); `4`
stamped revision not in this repository; `5` ambiguous repository history
(multiple heads); `6` unsupported database dialect (only MySQL and PostgreSQL are
valid migration targets, and the check runs before any connection is made).
**Any non-zero code: stop and fix the cause.**

Do not continue unless all of the following are true:

- the printed target is the database and environment you intend to migrate;
- the current revision is the expected one for this migration
  (`0011_platform_admin_default_false` while `0012` is pending);
- a backup exists **and has been test-restored** — a successful preflight
  connection does not prove a backup exists, and a file existing does not prove
  it restores. Follow `docs/backup-restore.md`: timestamped dump, integrity
  checks, restore into a scratch database, and revision/data verification.
  Managed-provider snapshots must also be restore-tested;
- the pre-migration platform-administrator list has been exported into the
  change ticket (not just left in the database): migration `0011` resets every
  flag and cannot identify who held one afterwards. Run this read-only query
  and preserve the output with the ticket:

  ```sql
  SELECT id, email, is_platform_admin, is_active
  FROM app_users
  WHERE is_platform_admin = 1
  ORDER BY id;
  ```
- a written recovery plan lists the individually verified platform
  administrators (by local directory email) who must be re-granted in 8.4.

### 8.2 Apply (maintenance window)

Quiesce application writers first: the migration takes metadata locks on
`app_users`, and MySQL DDL is not transactional.

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\backend
..\.venv\Scripts\alembic.exe current      # confirm again: 0011...
..\.venv\Scripts\alembic.exe upgrade head
..\.venv\Scripts\alembic.exe current      # expect: 0012_audit_platform_admin_reset
```

If the command fails part-way, do not edit `alembic_version` by hand. `0011`
sets the server default and every existing flag to false; `0012` only inserts a
durable audit record after the reset. Both are safe to re-run: `0011` is
idempotent, and `0012` skips its insert if the same event already exists.
Because MySQL commits DDL immediately, a failure after the `ALTER` but before
the version stamp leaves the secure default in place while the revision still
reads `0010`; a failure during the audit-only `0012` step leaves it at `0011`.
Re-running `upgrade head` is the documented repair.

### 8.3 Verify the reset

```sql
SELECT version_num FROM alembic_version;                      -- 0012...
SELECT COUNT(*) FROM app_users WHERE is_platform_admin = 1;   -- expected 0
SELECT actor, event_type, entity_id
FROM audit_events
WHERE event_type = 'users.platform_admin_reset_recorded';
```

The audit event also records the post-reset platform-administrator count. It is
a forward record, not a reconstruction of who was revoked; use the exported
pre-migration list from 8.1. Institution memberships are untouched by `0011`;
only the platform-wide flag is reset.

### 8.4 Re-grant only verified administrators

`scripts/bootstrap_admin.py` is the offline, audited recovery path (ADR-0014,
ADR-0018). It changes **one named local account**, never mass-grants or
mass-revokes, stores no password, and commits `users.bootstrap_admin` (or
`users.membership_upserted`) in the same transaction as the change. It can
change only that account's platform flag and, when explicitly requested, its
membership; a membership role change (including a demotion) requires
`--allow-role-change`.

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\backend
..\.venv\Scripts\python.exe ..\scripts\bootstrap_admin.py `
    --email verified.one@example.org --actor "ops:your-name"
# repeat exactly once per verified administrator
```

- `--actor` is required and must identify the operator; the legacy default
  `offline_operator` is refused. Every change is audited with the actor and the
  previous/resulting account and membership state.
- Use the account's exact directory email; verify the person out-of-band.
- To also grant an institution role, add `--institution-id N --role admin`.
- The command is idempotent: a second run only confirms the account is already
  an active platform administrator.
- A suspended account or membership is **never** reactivated implicitly. Pass
  `--reactivate-user` and/or `--reactivate-membership` only after verifying the
  person and the reason for suspension.
- An existing membership role is **never** changed implicitly. A role change
  additionally requires `--allow-role-change` and is audited with its previous
  and resulting role.
- There is no HTTP endpoint that grants platform administration. Do not add one.

Verify the result:

```sql
SELECT email FROM app_users WHERE is_platform_admin = 1;  -- exactly your list
```

and the audit trail:

```sql
SELECT actor, event_type, entity_id, occurred_at
FROM audit_events
WHERE event_type IN ('users.bootstrap_admin', 'users.membership_upserted')
ORDER BY occurred_at DESC;
```

### 8.5 Rollback

`0012`'s downgrade is an audit-preserving no-op: it leaves the audit event in
place and the schema unchanged. `alembic downgrade` from `0011` is
security-monotonic: it moves the version stamp back but **does not** restore the
unsafe `TRUE` default or the revoked privileges (ADR-0017), so it is not a way
to undo the security correction. Going below `0005_source_connectors` is
unsupported (ADR-0016).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/api/v1/health/ready` returns 503 | MySQL is not running: start Docker Compose or ignore it — only the database-dependent features care |
| Frontend shows "Could not reach the DataDiet API" | Start the backend on port 8000, or set `VITE_API_BASE_URL` in `.env` |
| `ModuleNotFoundError: app` | Run uvicorn/pytest **from `backend/`**, not the repository root |
| `alembic: command not found` | Use the full path `..\.venv\Scripts\alembic.exe` |
| Port 5173/8000 already in use | Stop the other process or pass `--port` / `server.port` overrides |
| `Access denied for user 'datadiet'` | Recreate the container volume: `docker compose -f infra/docker-compose.dev.yml down -v` then start again |
| App redirects to `/signin` | You are signed out (or have no token). Use the development sign-in form in development; in production this means auth is configured but your token is missing/expired |
| Sign-in page says "not configured" | Expected in production until an operator sets `AUTH_JWT_SECRET` (see `.env.example`) — endpoints fail closed with 503 `auth_not_configured:` by design |
| A page action is missing although the API works | The action is permission-gated for your role (ADR-0014); sign in with an account whose role has the permission |
| A backup or restore fails | Follow `docs/backup-restore.md`; never hand-edit a dump or `alembic_version` |
