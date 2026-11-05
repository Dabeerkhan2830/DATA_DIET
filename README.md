# DataDiet

**Intelligent data lifecycle and privacy-management platform.** DataDiet
inventories institutional records, identifies duplicate candidates, assesses
sensitivity with explainable risk indicators, evaluates versioned retention
policies and holds, and prepares human-approved lifecycle actions — without
ever deleting data automatically.

> **Status: development/test only.** This repository contains a working, tested
> application through Phase 9. It executes **no lifecycle action** (archive,
> restore, move, delete, dispose) and connects to **no institutional system**.
> Authentication and authorization exist for development/test; production
> fails closed without a valid signing secret, but no real OIDC/RS256 identity
> provider is implemented. The remaining production blockers are tracked in
> `docs/production-readiness.md`. Every figure shown in the UI is explicitly
> labeled synthetic demo data. See `docs/architecture.md` for the
> capability-by-capability status.

## Stack

| Layer | Technology | Version |
| --- | --- | --- |
| Frontend | React, TypeScript (strict), Tailwind CSS, Vite | React 19.3 · TS 5.9 · Tailwind 4.3 · Vite 6.4 |
| Backend | Python, FastAPI, Pydantic v2, SQLAlchemy 2 | FastAPI 0.143 · Pydantic 2.14 · SQLAlchemy 2.1 |
| Database | MySQL (Alembic migrations) | MySQL 8.4 |
| Web server | Nginx (future deployment config, `infra/nginx/`) | 1.27 |
| Tests | pytest + ruff · Vitest + Testing Library | pytest 9.1 · Vitest 3.2 |

## Repository layout

```
DataDiet/
├── frontend/   React + TypeScript + Tailwind (Vite)
├── backend/    FastAPI app (api / services / db layers) + tests
├── database/   Alembic migrations (schema authority) and docs
├── infra/      docker-compose.dev.yml + future Nginx configuration
├── docs/       architecture, setup, decisions, backup/restore, production readiness
├── scripts/    validation gate + operator scripts (preflight, admin recovery)
├── .github/    GitHub Actions CI workflow
├── .env.example
└── AGENTS.md   instructions for AI/automation contributors
```

## Quick start (Windows PowerShell)

```powershell
Set-Location C:\Users\yadav\Desktop\DataDiet
Copy-Item .env.example .env

# --- Backend (terminal 1) ---
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
Set-Location backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
#   API:  http://127.0.0.1:8000/docs

# --- Frontend (terminal 2) ---
Set-Location C:\Users\yadav\Desktop\DataDiet\frontend
npm install
npm run dev
#   UI:   http://localhost:5173

# --- Database (optional, needs Docker Desktop) ---
Set-Location C:\Users\yadav\Desktop\DataDiet
docker compose -f infra/docker-compose.dev.yml up -d mysql
Set-Location backend
..\.venv\Scripts\alembic.exe upgrade head
```

Full instructions, troubleshooting, and migration workflow: `docs/setup.md`.

## What the application delivers

- Responsive institutional dashboard with sidebar navigation (Dashboard, Data
  Inventory, Risk Analysis, Retention Policies, Archive, Retrieval Requests,
  Reports, User Management) and mobile drawer.
- FastAPI application with health/readiness probes and Swagger documentation.
- MySQL development configuration and Alembic migrations through
  `0012_audit_platform_admin_reset`, with validated environment settings.
- Typed frontend API client with loading, empty, and error states on every view.
- Synthetic sample data served through a `synthetic_demo_data`-labeled API.
- Automated tests: the backend pytest suite (some MySQL tests skip without a
  disposable database) and 80 frontend (Vitest) tests, plus 19 live MySQL
  migration tests when explicitly enabled with
  `MIGRATION_TEST_ALLOW_DROP=1` and `MIGRATION_TEST_DB_URL`.

## Checks

```powershell
.\scripts\check.ps1          # everything (Windows PowerShell 5.1)
```

Individually: `backend`: `..\.venv\Scripts\python.exe -m pytest`,
`-m ruff check .`, and `-m ruff check ..\scripts`; `frontend`: `npm run
typecheck`, `npm test`, `npm run build`.

`.github/workflows/ci.yml` is configured to run the equivalent checks on pull
requests and pushes to `main` on Linux, plus the disposable MySQL migration
suite. It has not yet executed on GitHub. See `docs/setup.md` and
`docs/production-readiness.md`.

## Safety principles (non-negotiable)

1. **No automatic deletion, ever.** Disposal requires documented policy
   evaluation and explicit human approval.
2. **No real personal data in development.** Synthetic fixtures only.
3. **No real institutional connections** until a connector is implemented,
   reviewed, and tested.
4. **No production database tables created by hand** — models change, then
   migrations.
5. **No server-side secrets in the frontend.** Database URLs, signing keys,
   service credentials, and API keys stay in backend environment variables;
   only `VITE_*` values reach the browser bundle, and no secret belongs in one.
   Signed bearer tokens are sent to the browser and stored in `localStorage`,
   so an XSS would expose a session until expiry; that residual risk is tracked
   in `docs/production-readiness.md`.
6. **No capability claimed before it is implemented and tested.** Unbuilt
   features say so in the UI and in `docs/`.
7. **No arbitrary scoring.** Every risk point traces to a documented, tested
   rule (see `docs/decisions.md`, ADR-0005).

## Documentation

| Document | Contents |
| --- | --- |
| `docs/architecture.md` | Components, layering, schema, safety boundaries, phase map |
| `docs/setup.md` | Exact PowerShell setup, run, test, and migration commands |
| `docs/decisions.md` | Decision records, including the risk rule table |
| `docs/backup-restore.md` | Backup, integrity, scratch restore, approval, and drill record |
| `docs/production-readiness.md` | Production blockers and the ordered deployment gate |
| `database/README.md` | Migration workflow and development MySQL details |
| `infra/README.md` | Docker Compose and Nginx usage |

License: proprietary (placeholder — update for your institution).
