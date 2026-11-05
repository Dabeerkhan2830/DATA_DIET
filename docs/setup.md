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

## 4. Database (MySQL, optional in Phase 1)

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

Expected result: `0012_audit_platform_admin_reset` (head). Without Docker,
skip this section — the application still runs and reports the database as
unreachable.

Supported rollback boundary: **`0005_source_connectors`** — do not
`alembic downgrade` below it (ADR-0016 explains the safe failure mode and the
repair procedure if you do).

Applying migrations to an **existing** database is a privileged operation —
especially `0011`, which resets every platform-admin flag. Follow the migration
runbook in section 8 instead of running `upgrade head` directly, and take a
test-restored backup first (`docs/backup-restore.md`).

## 5. Signing in (Phase 7)

Every endpoint except `/api/v1/health` and `/api/v1/auth/config` requires a
signed bearer token (ADR-0014). How you get one depends on the deployment:

- **Development (default):** open http://localhost:5173 and use the
  *Development sign-in* form on `/signin`. It calls `POST /api/v1/auth/dev-login`,
  which creates/reuses a synthetic local account and issues a real HS256 token
  through the same verification path as every other token. This is explicitly
  **not** production authentication and is hard-disabled when
  `ENVIRONMENT=production` (503 `sign_in_unavailable:`).
- **Bearer boundary:** paste an externally issued token (HS256, your
  `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE` claims, a `sub` or `email` matching a
  local account). The sign-in page shows the exact contract from
  `/api/v1/auth/config`.
- **Unconfigured:** the page says authentication is not configured instead of
  showing a form. In production this is the state until an operator sets a real
  `AUTH_JWT_SECRET` — every protected endpoint then returns 503
  `auth_not_configured:` (fail closed by design).

Create the first platform administrator offline (there is no HTTP bootstrap):

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\backend
..\.venv\Scripts\python.exe ..\scripts\bootstrap_admin.py --email admin@example.org --institution-id 1 --role admin --actor "ops:your-name"
```

The same command is the audited recovery path after migration `0011` resets
existing platform-admin flags (see section 8.4). It promotes exactly the named
account and never mass-grants.

Authorization (roles, institution scope) always comes from the local user
directory, never from token claims. Sign-out is client-side: the token is
discarded from `localStorage` (bearer tokens are stateless; there is no logout
endpoint).

## 6. Run the checks

Backend:

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\backend
..\.venv\Scripts\python.exe -m pytest              # backend tests; some skip without MySQL
..\.venv\Scripts\python.exe -m ruff check .         # backend lint
..\.venv\Scripts\python.exe -m ruff check ..\scripts  # operator scripts (same Ruff config)

# The 19 MySQL migration tests run only with an explicitly opted-in,
# disposable loopback database. The guard refuses production-like names,
# non-loopback hosts, and any target equal to DATABASE_URL:
# $env:MIGRATION_TEST_ALLOW_DROP = "1"
# $env:MIGRATION_TEST_DB_URL = "mysql+pymysql://root:@127.0.0.1:3307/datadiet_mig"
# ..\.venv\Scripts\python.exe -m pytest tests/test_migrations_mysql.py     # 19 tests
```

Frontend:

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet\frontend
npm run typecheck     # tsc strict, no emit
npm test              # vitest run, 80 tests
npm run build         # production bundle into dist/
```

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
restore drills are in `docs/backup-restore.md`.

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

Supported engine: MySQL 8.x. The development compose file pins `mysql:8.4`.
The live migration suite passed 19/19 on MySQL 8.0.46 locally; CI is configured
to use `mysql:8.4` but has not run on GitHub. The Alembic chain is only
exercised on MySQL; do not run it against another engine. The preflight rejects
non-MySQL dialects with exit code 6.

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
(multiple heads); `6` unsupported database dialect (only MySQL is a valid
migration target). **Any non-zero code: stop and fix the cause.**

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
