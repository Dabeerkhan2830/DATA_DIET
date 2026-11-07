# Render staging runbook (prepared, **not deployed**)

Phase 6.0 (ADR-0025) makes PostgreSQL + Clerk the staging target and names
Render as the intended host. This document is the *preparation*: the service
shapes, commands, environment variables, secret names, access strategy,
migration procedure, backup and rollback for a private DataDiet staging
environment on Render.

> **Nothing here has been executed.** The authoring environment has no Render
> account, no `render` CLI, and no network path to Render's API, and deploying
> was explicitly out of scope for Phase 6.0. Every command below is written for
> an operator who is standing in the Render dashboard with real credentials.
> Where a fact comes from Render's own documentation it is cited; where the
> documentation available at authoring time (2026-11-04) did not answer the
> question, the text says **unverified** instead of guessing. Section 12 is the
> gate that turns "documented" into "verified" — do not mark a step done because
> the command looked plausible.
>
> Related: [docs/setup.md](setup.md) (local workflow),
> [docs/production-readiness.md](production-readiness.md) (open blockers),
> [ADR-0025](decisions.md) (why Clerk + PostgreSQL),
> [docs/azure-deployment.md](azure-deployment.md) (the Azure alternative — an
> unrelated, equally unexecuted runbook).

---

## 1. What this environment is for

A single private staging deployment whose purpose is to prove three things that
local testing cannot prove:

1. that a **real Clerk instance** issues RS256 session tokens this API accepts,
   and that an unbound subject is refused (`unknown_account`);
2. that the **PostgreSQL** migration chain (`0013_postgresql_baseline` →
   `0014_external_identities`) builds a working schema on a real server;
3. that the **frontend ↔ backend contract** survives the browser: sign-in,
   `GET /api/v1/auth/me`, permission-aware navigation, and 401 forced sign-out.

Item 1 is the reason this runbook exists at all: [ADR-0025](decisions.md)
records that the Clerk verification code is proven only against locally
generated RSA keys and a local JWKS document. No DataDiet test has ever
contacted Clerk.

Non-goals: no production data, no real institutional systems, no automatic
migrations, no automatic deletion, and no claim that Render is the final hosting
decision.

## 2. Target topology

| Render resource | Type | Purpose |
| --- | --- | --- |
| `datadiet-staging-api` | Web Service (Python runtime) | FastAPI, `/api/v1/*` |
| `datadiet-staging-web` | Static Site | the built Vite SPA |
| `datadiet-staging-db` | PostgreSQL | the only durable store |

One environment per staging stack, one stack per environment. Do not share a
database between staging and production, and do not reuse a development
MySQL schema: the chain below is the PostgreSQL entry path, not an in-place
engine conversion. There is no supported MySQL→PostgreSQL data migration in this
repository; staging starts empty with synthetic data.

## 3. Prerequisites before the first deploy

Four things must exist in the branch (or the account) you link. Three of them do
not exist yet.

| # | Prerequisite | Status in this repo | What to do |
| --- | --- | --- | --- |
| P1 | `.python-version` at the repo root | **absent** | Add the file with one line: the exact interpreter you validated against. Render's Python-version page states that the **file** selects the version and that a `PYTHON_VERSION` environment variable does not ([render.com/docs/python](https://render.com/docs/python)). The backend targets Python 3.11+ ([AGENTS.md](../AGENTS.md) conventions); whatever you pin must be a version Render builds wheels for, and `psycopg2-binary` ships wheels for the pinned interpreter. |
| P2 | `render.yaml` | **deliberately absent** | See section 4 — a committed blueprint auto-provisions on push. |
| P3 | `CLERK_ISSUER` reachable configuration | n/a | A Clerk application, its frontend-API origin (`https://<instance>.clerk.accounts.app` or `.accounts.dev`), and a JWT template whose `aud` matches `CLERK_AUDIENCE` if you set one. |
| P4 | Admin account in the directory | exists as tooling | `scripts/bootstrap_admin.py` then `scripts/bind_clerk_identity.py` against the *staging* database, after migrations (sections 7 and 9). |

There is no `Dockerfile` anywhere in this repository, so the Render web service
is the native Python build path, not a Docker path. If you prefer Docker, that
is a different, unrehearsed procedure and every section below it stops applying.

## 4. The Blueprint: why it is documented here and not committed

Render reads `render.yaml` from the **repository root**, and its own Blueprint
documentation describes the behaviour that follows: each push to the linked
branch that modifies the blueprint deploys or re-provisions the added and
modified resources. A file committed while the repository is linked to an
account is therefore an unattended provisioning path — exactly what "prepare,
do not deploy" forbids. This is the same reasoning the project applies to
destructive automation ([ADR-0018](decisions.md) keeps migrations behind a human
gate; [ADR-0021](decisions.md) keeps the Azure workflow behind a protected
environment and manual dispatch).

Recommendation: keep the blueprint out of the repository until an operator
decides otherwise, create the three resources manually from the dashboard
sections 5–8, and only then adopt the file below — at which point set the
service's `autoDeployTrigger` deliberately rather than accepting the default.
The `Validate Blueprint` API endpoint plans the changes and does not execute
them; it is the safe way to lint this YAML before any deploy.

```yaml
# render.yaml — COPY-PASTE ONLY AFTER READING SECTION 4.
# Every <angle-bracket> value is an operator decision. Nothing here is a secret,
# and deliberately no DATABASE_URL appears: see section 6.
services:
  - type: web
    name: datadiet-staging-api
    runtime: python
    region: <choose-and-record>
    plan: <paid: the free plan gives no shell and no one-off jobs>
    rootDir: backend            # requirements.txt + alembic.ini live here
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn app.main:app --host 0.0.0.0 --port $PORT
    healthCheckPath: /api/v1/health
    autoDeployTrigger: off      # staging is human-driven, not push-driven
    envVars:
      - key: ENVIRONMENT
        value: staging
      - key: CORS_ORIGINS       # section 8
        value: <https origin of datadiet-staging-web, exact scheme+host>
      - key: CLERK_ISSUER       # section 7 — this is what switches Clerk on
        value: <https://clerk-instance-frontend-origin>
      - key: CLERK_AUDIENCE     # omit if the JWT template carries no `aud`
        value: <the aud in the Clerk JWT template>
      - key: CLERK_AUTO_PROVISION
        value: "false"
      - key: DEMO_DATA_ENABLED
        value: "true"           # section 10 — make this an explicit decision
      - key: AUTH_DEV_PROVIDER_ENABLED
        value: "false"          # redundant by design: the route is not registered

  - type: web
    name: datadiet-staging-web
    runtime: static
    rootDir: frontend
    buildCommand: npm ci && npm run build
    publishPath: dist
    autoDeployTrigger: off
    envVars:
      - key: VITE_API_BASE_URL
        value: <https origin of datadiet-staging-api>
      - key: VITE_CLERK_PUBLISHABLE_KEY
        value: <pk_test_... — public by design; see the note below>

databases:
  - name: datadiet-staging-db
    databaseName: datadiet_staging
    plan: <paid>
```

**The env-var shapes above are the ones Render's Blueprint specification shows
verbatim** (`key` + `value`, and `fromGroup: <group>` /
`fromDatabase: {name, property}` / `generateValue` / `sync` as alternatives).
Two consequences, stated rather than glossed:

- **`DATABASE_URL` is not in the file.** The key that marks a blueprint value as
  an encrypted Environment Secret was **not visible in the documentation
  retrieved at authoring time**, so this runbook does not invent one. Create
  `DATABASE_URL` in the dashboard as an encrypted secret (section 6, option 1),
  and if you later adopt the blueprint, confirm the current documented key before
  writing a credential-bearing value into a file that git will remember. The
  alternative Render does document is an **environment group** (`fromGroup`):
  keep the credential in the group, reference the group here, and the file stays
  secret-free.
- **The obvious `fromDatabase: {property: connectionString}` line is wrong for
  this application**, because Render's connection string is `postgresql://…` and
  the app requires the `+psycopg2` driver suffix — see section 6. It is omitted
  here on purpose; do not "simplify" it back in.

A real `pk_test_…` publishable key is not a secret, but it is still an
institution-specific identifier; if this repository may become public, set it in
the dashboard or an environment group rather than committing it.


## 5. Backend service configuration

Verified from Render's FastAPI quickstart ([render.com/docs/using-fastapi](https://render.com/docs/using-fastapi))
and environment-variable pages:

- **Build:** `pip install -r requirements.txt` from `backend/` (hence
  `rootDir: backend`). Do **not** install `backend/requirements-dev.txt` on the
  service — it pulls `pytest`, `ruff`, and `pgserver`, an embedded PostgreSQL
  meant only for this repository's tests.
- **Start:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`. Two things are
  non-negotiable: `--host 0.0.0.0` (Render routes to the container's published
  interface; an app bound to 127.0.0.1 is unreachable) and `$PORT` (Render
  assigns the port and exports it; the app does not read `API_PORT` —
  `.env.example` records that `API_HOST`/`API_PORT` are not read by the
  application at all).
- **Health path:** `/api/v1/health` — liveness, never touches the database
  ([backend/app/api/routes/health.py](../backend/app/api/routes/health.py)).
  Use `/api/v1/health/ready` as the *operator's* pre-cutover check instead of
  the platform health path: readiness reports 503 while the database is
  unreachable, so wiring it to `healthCheckPath` makes Render treat a database
  outage as a broken instance and recycle a service that is otherwise serving
  correctly. Render's health-traffic documentation describes the failure and
  restart windows; **unverified here** — read the current numbers before relying
  on the behaviour.
- **Wsgi/ASGI:** the app object is `app.main:app` (module path relative to
  `backend/`), created by `create_app()`, which is where `ENVIRONMENT` decides
  whether the dev-login route exists at all.

## 6. Database configuration, and one real gotcha

Render's PostgreSQL provides an **internal** connection string (reachable only
from Render services in the same region/network) and an **external** one
(public, gated by a CIDR allow list in the dashboard). Staging uses the internal
string exclusively; the external path stays disabled because nothing outside
Render needs to reach the database, and the brief forbids exposing PostgreSQL
beyond the connectivity the backend needs.

**Gotcha — the driver suffix.** Render's `connectionString` is
`postgresql://user:password@host:port/dbname`. This application requires
`postgresql+psycopg2://`: `backend/app/core/config.py:57-60` documents that a
bare `postgresql://` URL makes SQLAlchemy import psycopg **3**, which is not
installed, so the engine fails at connect time with a confusing import error,
and nothing in the codebase rewrites the URL. Render's Blueprint specification
shows `key` + `value`, `fromGroup: <group>`, `fromDatabase: {name, property}`,
`generateValue` and `sync`, and offers **no string-splicing or `{OTHER_VAR}`
interpolation**, so you cannot prefix the injected value.

Choose one of these, and record which you chose in the change ticket:

1. **Explicit encrypted secret (recommended).** In the dashboard, create
   `DATABASE_URL` as an Environment Secret carrying the internal connection
   values with the driver added, in full:
   `postgresql+psycopg2://<user>:<password>@<internal-host>:<port>/<dbname>?sslmode=require`
   This is the only option that satisfies both the driver requirement and the
   "secrets live in the platform's secret store" rule in `.env.example`. The
   password never appears in a committed `value:` entry and never in the
   repository. Keep the file secret-free by putting it in an environment group
   (`fromGroup`) if you want the blueprint to reference it.
2. **Separate `fromDatabase` keys + a code change.** Inject `user`, `password`,
   `host`, `port`, `database` individually and compose the URL at startup. This
   repository does **not** do that today, and adding it is a configuration-contract
   change that needs its own ADR — do not treat it as plumbing.

`sslmode` is the PostgreSQL equivalent of the MySQL
`require_secure_transport` discussion in `docs/azure-deployment.md` section 6.
Render's managed PostgreSQL serves TLS on the internal endpoint; the application
passes no TLS options of its own, so the requirement lives in the URL query
string. If the connection fails after you add `sslmode=require`, that is
information about the endpoint, not a licence to drop it.

**Least privilege.** The application's role needs DML plus the DDL Alembic runs
during a reviewed migration window; it must not be a superuser, and the runtime
service and the migration operator are allowed to use different roles on the
same database if the platform admin wants that split. Because Alembic is invoked
manually (section 9), the least-privilege story is: give the service a role with
no `CREATEDB`/`CREATEROLE`/superuser rights, and hold the DDL-capable credential
outside the service environment.

## 7. Clerk configuration

Three server-side names plus one browser name. Values are in the Clerk
dashboard; none of them is a DataDiet secret.

| Name | Where | Rule |
| --- | --- | --- |
| `CLERK_ISSUER` | API env (plaintext) | The Clerk instance's frontend-API origin, e.g. `https://<instance>.clerk.accounts.app`. Setting this is *what enables Clerk* — with it unset, the API falls back to the ADR-0014 HS256 bearer boundary. Must be HTTPS (loopback allowed only for local fixtures) or a protected environment refuses to start. |
| `CLERK_JWKS_URL` | API env (usually unset) | Derived from the issuer as `<issuer>/.well-known/jwks.json` when empty, which is the shape Clerk documents; set it only if your instance serves keys elsewhere. |
| `CLERK_AUDIENCE` | API env | Set only when the JWT template emits `aud`; the value must match the template exactly. Empty means "this template carries no audience". |
| `CLERK_AUTO_PROVISION` | API env | `false` (the default and the recommended staging value): an unrecognised subject is refused 401 `unknown_account` and an operator binds it. |
| `VITE_CLERK_PUBLISHABLE_KEY` | Static Site env, **build-time** | Clerk's *publishable* `pk_…` key. Public by design; identifies the instance and grants nothing. |

There is deliberately **no `CLERK_SECRET_KEY` anywhere**, on Render or in
`.env.example`. This API is a resource server ([ADR-0025](decisions.md)): it
verifies RS256 session tokens against the public JWKS and never calls Clerk's
server-side API, so it holds no Clerk credential to leak. Do not add one to
"make login work" — if sign-in is failing, the cause is the issuer, the audience,
or a missing binding, not a missing secret key.

Two ordering rules that have bitten in every fresh environment:

1. **Configure both halves together.** `VITE_CLERK_PUBLISHABLE_KEY` set while
   `CLERK_ISSUER` is unset produces a UI showing Clerk's form against an API that
   refuses Clerk tokens. `CLERK_ISSUER` set without the publishable key produces
   an API that accepts only Clerk tokens and a frontend with no way to obtain
   one; the sign-in screen then reports the honest
   `identity_provider_unavailable` / "no session has been granted" state rather
   than a fake login.
2. **Bind before first sign-in.** `VITE_` variables are baked into the bundle at
   build time, so changing the publishable key requires a rebuild. Create the
   local account (`scripts/bootstrap_admin.py`), bind its Clerk subject
   (`scripts/bind_clerk_identity.py bind --subject user_… --email … --actor ops:<name>`),
   *then* sign in. `GET /api/v1/auth/me` is the only source of permissions;
   nothing in Clerk's user or public metadata is read for authorization.

`ENVIRONMENT=staging` is what makes the environment *protected*
([backend/app/core/config.py:127](../backend/app/core/config.py#L127)): the
development placeholder secret is rejected, `AUTH_DEV_PROVIDER_ENABLED` is forced
false, and `POST /api/v1/auth/dev-login` is not registered at all (404, and absent
from the OpenAPI document) rather than a route that exists and complains
([ADR-0025](decisions.md)). Do not deploy with `ENVIRONMENT=development` "to get
it running first" — that is the configuration the brief prohibits on a public
URL.

## 8. CORS

`CORS_ORIGINS` is the exact browser origin of the Static Site, including scheme,
e.g. `https://datadiet-staging-web.onrender.com`. Render assigns the hostname at
provision time, so the API's env var must be set (or corrected) after the static
site exists, and `VITE_API_BASE_URL` on the frontend must be the API's origin in
the other direction. Both are build/start-time values; get them wrong and the
browser reports a CORS failure that looks like an auth failure.

Rules carried over from `.env.example` and `config.py`: the comma-separated flat
string is the portable form (JSON arrays are also accepted); never `*` with
credentials; never an `http://` origin in a protected environment. With
`VITE_API_BASE_URL` set, the frontend calls the API cross-origin, so the API's
CORS list must be correct — the Vite dev-server proxy that makes CORS invisible
locally does not exist in staging.

## 9. Migrations: a separately reviewed, human-triggered operation

**No automatic migrations, anywhere in this runbook.** Specifically:

- The application never runs Alembic at startup — `create_app()` does not call
  it, and nothing in the start command does.
- Render's `preDeployCommand` (documented for `web`, `pserv`, `worker`, `cron`,
  and `workflow` types) is **not** used here even though it exists, because it
  runs unattended on every deploy. A migration that resets privilege or widens
  a column is a privileged change with a backup precondition, which is the exact
  reasoning behind [ADR-0018](decisions.md)'s human gate. A deploy mechanism
  cannot hold those gates.
- `scripts/migration_preflight.py` runs first, always, and any non-zero exit
  stops the procedure.

The PostgreSQL entry path is **stamp, then upgrade** — not `upgrade head` from
nothing, because revisions `0001`–`0012` are MySQL-shaped and `0013` is the
PostgreSQL baseline
([database/migrations/versions/0013_postgresql_baseline.py](../database/migrations/versions/0013_postgresql_baseline.py)):

```bash
# 1. Read-only. Check the printed target is the staging database, and that the
#    dialect is accepted (exit 6 = unsupported engine, e.g. SQLite).
python ../scripts/migration_preflight.py

# 2. Fresh PostgreSQL database only: stamp the pre-baseline revision.
alembic stamp 0012_audit_platform_admin_reset

# 3. Apply the baseline and everything after it.
alembic upgrade head

# 4. Confirm a single head at 0014_external_identities.
alembic current
```

`DATABASE_URL` is read from the environment by `database/migrations/env.py`, so
these commands must run with the staging URL in scope, from `backend/`
(`alembic.ini` sets `script_location = ../database/migrations`, relative to that
directory). Where to run them:

- **Dashboard shell** — requires a paid instance type. Free instance types get
  neither the shell nor one-off jobs, so a free-tier staging stack has no
  supported migration path at all. Activate the build's virtual environment as
  Render's shell documentation describes (**unverified here**: the venv location
  is documented by Render, not by this repository) before assuming `alembic` and
  `python` resolve to the installed dependencies.
- **One-off job** — `POST /v1/services/{serviceId}/jobs` with the command string
  (`{"command": "cd backend && alembic upgrade head"}`). Also requires paid
  compute. Authenticate with a Render API key held as a local secret; never put
  the key in a repository, a ticket, or a shell history file you will share.

Before step 3, the [backup rule](backup-restore.md) applies unchanged: a
timestamped dump that has been **test-restored** into a scratch database. A
snapshot that has never been restored is not a backup. `docs/setup.md` section 8
and `docs/backup-restore.md` were written for MySQL; the equivalent staging
sequence is `pg_dump` of the staging database plus a restore into a scratch
PostgreSQL instance, re-running `alembic current` against the copy and verifying
the revision and row counts.

## 10. Keeping staging private

The brief requires private staging, and requires that the development login not
merely be hidden. What Render documents, in decreasing order of usefulness here:

1. **`ENVIRONMENT=staging`** — the route does not exist (section 7). This is the
   protection that actually matters and it is enforced by this repository, not
   by the platform.
2. **Do not seed credentials.** A fresh staging database has no accounts until
   an operator runs `bootstrap_admin.py`, so an unauthenticated visitor reaches
   the sign-in screen and nothing behind it. Every account created afterwards
   maps to a manually bound Clerk subject.
3. **`ipAllowList`** — restricts ingress to listed CIDRs. **Scale/Enterprise
   plans only** ([render.com/docs/blueprint-spec](https://render.com/docs/blueprint-spec));
   on a standard plan this is not available and you must not describe staging as
   IP-restricted.
4. **`renderSubdomainPolicy`** — Render accepts `enabled` or `disabled`
   (same citation). `disabled` removes the `*.onrender.com` hostname, which means
   a custom domain must be attached; that is the closest documented platform-level
   "make the guessable public hostname go away" switch.
5. **Private services** (`type: pserv`) are reachable only inside Render's
   network — the API is a `web` service because it must serve the browser, so
   this lever does not apply to it. The database is already non-public by
   default (internal connection string only, section 6).
6. **Basic auth / Auth@Edge / restricted service tickets:** **not documented** in
   the Render material available at authoring time. Do not write "behind platform
   basic auth" in a ticket on the strength of a memory. If you need an
   identity-less gate, the honest options are `ipAllowList` (higher plan) or a
   reverse proxy you operate. This gap is listed in section 12.

Private access is therefore: *unguessable-by-default is not the strategy;
no-credentials + provider-authenticated + refuses-everything-else is.* An
unauthenticated request to a protected endpoint answers 503
`auth_not_configured:` when nothing is configured and 401 when the token is wrong
— never a permission, never a listing.

`DEMO_DATA_ENABLED` deserves a decision, not a default. `/api/v1/demo/*` serves
synthetic fixtures with the `SYNTH-` prefix and the `synthetic_demo_data`
envelope ([AGENTS.md](../AGENTS.md) rule 3). Leaving it `true` in staging makes
first sign-in show something; the cost is public endpoints that serve
non-production data. If staging will ever be reachable by a person who is not
the operator, set it `false` and seed a small synthetic set through the real
ingestion routes instead. Record whichever you chose.

## 11. Secrets, rotation, and what may be plaintext

Only names appear in this document. Never paste a value into a ticket, a
commit, a chat message, or `docs/`.

| Name | Kind | Placement |
| --- | --- | --- |
| `DATABASE_URL` | secret (credential-bearing) | Environment Secret / env group, section 6 option 1 — never a committed blueprint `value:` |
| `CLERK_ISSUER`, `CLERK_JWKS_URL`, `CLERK_AUDIENCE`, `CLERK_AUTO_PROVISION` | configuration | plaintext env — these identify an instance and grant nothing |
| `VITE_CLERK_PUBLISHABLE_KEY` | public by design | env var, baked into the bundle |
| `AUTH_JWT_SECRET` | secret | **unset in staging when Clerk is configured.** Set only if you are deliberately running the ADR-0014 HS256 bearer boundary; ≥32 characters, generated with `python -c "import secrets; print(secrets.token_urlsafe(48))"`, never in a `VITE_` variable |
| `LOCAL_SOURCE_ROOTS` | configuration | unset in staging — local-folder sources point at *the server's* filesystem; leave empty unless deliberately mounted |
| Render API key | secret | operator's machine only, never in the service environment |

Rotation: `DATABASE_URL` rotation means the secret plus a restart, and a verified
backup beforehand. Clerk key rotation is automatic and requires nothing here —
`core/jwks.py` refetches on an unknown `kid`, at most once per
`DEFAULT_MIN_REFRESH_INTERVAL_SECONDS`, and keeps the previously cached keys if
the fetch fails. The legacy `AUTH_JWT_SECRET` has no key ID and no overlapping
rotation, which [docs/production-readiness.md](production-readiness.md) already
records as a blocker; that is another reason not to keep it in staging.

`GET /api/v1/health/ready` is deliberately credential-free: it reports the
database gate as `reachable` plus a detail string, and the authentication block
as configured/provider/issuer/detail. It is safe to expose the path — but check
its output once before declaring staging private, and if the issuer shown is not
your Clerk instance, fix the configuration rather than the check.

## 12. Validation gate: what must be observed before this counts as real

Nothing above is verified. The deploy is "done" only when every row is checked
with a dated note, and the "not verified" rows are carried forward as open
risks.

| # | Statement | Verified by | Evidence so far |
| --- | --- | --- | --- |
| V1 | `render.yaml` block in section 4 compiles and plans | `Validate Blueprint` API or dashboard paste | **not run** — no Render access here |
| V2 | `.python-version` selects the intended interpreter | first build log | **not run**; file does not exist yet |
| V3 | `pip install -r requirements.txt` + `uvicorn app.main:app --host 0.0.0.0 --port $PORT` boots | live service log | **not run**. Locally, the same runtime dependency set (plus `requirements-dev.txt`) is what the 360-test backend suite installs against, and the 10 PostgreSQL migration tests pass against a real server via `pgserver` — see `docs/setup.md` section 6 |
| V4 | PostgreSQL `stamp 0012 → upgrade head` yields one head at `0014` with 20 tables | `alembic current` + `information_schema` count | **not run against Render**. Run against a real PostgreSQL server in tests (`backend/tests/test_migrations_postgresql.py`) |
| V5 | A real Clerk session token is accepted | sign in on staging, inspect `GET /api/v1/auth/me` | **not run** — never exercised against a live provider ([ADR-0025](decisions.md)) |
| V6 | An unbound subject is refused `unknown_account` | staging, second Clerk user | **not run**; proven only with local keys + local directory |
| V7 | Dev-login is 404 and absent from `/openapi.json` | `curl -i` on staging | **not run**; proven by `create_app` gating and route tests |
| V8 | The frontend sends a Clerk token per request and a 401 forces sign-out | staging browser, Network + Application storage tabs, no token in `localStorage` | **not run**; proven by `frontend/src/auth/ClerkAuth.test.tsx` against an SDK stand-in |
| V9 | CORS works cross-origin with `VITE_API_BASE_URL` set | staging browser console | **not run** |
| V10 | `pg_dump` restore into a scratch instance succeeds | restore drill, checksums | **not run** for PostgreSQL (the documented drill in `docs/backup-restore.md` is MySQL, at revision `0011`) |
| V11 | Health-path choice behaves as section 5 describes during a forced DB outage | staging, stop the DB or point `DATABASE_URL` at a bad host | **not run** |
| V12 | An identity-less platform gate exists for staging | section 10 items 3/4/6 | **open design gap**: `ipAllowList` needs Scale/Enterprise, and basic auth/Auth@Edge are not documented |

## 13. Rollback

Two distinct things get rolled back, and they do not roll back together.

**Application.** Render's deploy history reuses the stored build artifact, so a
rollback does not rebuild, and environment variables are preserved. Roll back the
API, then re-check `/api/v1/health` and the signed-in round trip. A frontend
rollback is a new bundle: `VITE_` values are already baked into it, so an
artifact from before the publishable key existed shows DataDiet's own sign-in
screen, not an error.

**Schema.** Forward-only by decision. `0013`'s downgrade raises instead of
dropping the baseline, so there is no supported `alembic downgrade` path past
it ([ADR-0025](decisions.md)), and a rollback of a *bad applied migration* is a
restore of the pre-change dump into a scratch instance, verification there, then
a deliberate restore decision — not `alembic downgrade -1` against a live
database. Roll the application back to the previous release instead and leave
the schema where it is, provided the new columns are additive (both Phase 6.0
revisions are).

**Database instance.** Render's restore creates a **new** instance (Recovery
flow); point-to-in-time recovery is a paid feature. Treat a staging-database
"revert" as re-provision + re-migrate + re-bind + re-seed, which for synthetic
staging data is usually cheaper and always more predictable. The
`external_identities` rows are small and operator-created, so re-running
`scripts/bind_clerk_identity.py` (with `list` first to see current state) is the
documented way to rebuild access after a rebuild.

## 14. Explicit non-actions of this phase

- No Render account, resource, deploy, or blueprint file was created.
- No Floci provisioning or deployment — Floci stays undeployed by design
  (`docs/azure-architecture.md` and the prior Render/Floci feasibility work).
- No Alembic command was run against a remote or managed database.
- No real personal data, no real institutional system, no live Clerk instance.
- No secret value appears in this repository; names only.
- No production configuration; `ENVIRONMENT=production` is not exercised here.
