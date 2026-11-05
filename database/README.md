# Database layer — MySQL schema and migrations

The **application models** in `backend/app/db/models.py` are the source of
truth for the schema; **Alembic** owns creating and evolving the actual
database. Never create or alter tables by hand outside of local experiments.

## Layout

| Path | Purpose |
| --- | --- |
| `migrations/env.py` | Alembic environment; loads `DATABASE_URL` from app settings |
| `migrations/script.py.mako` | Template for new revision files |
| `migrations/versions/` | Migration revisions (starts at `0001_initial_schema`) |

`backend/alembic.ini` points at this directory (`script_location = ../database/migrations`),
so all Alembic commands run from `backend/`.

## MySQL development database (Docker)

From the repository root (requires Docker Desktop):

```powershell
docker compose -f infra/docker-compose.dev.yml up -d mysql
```

Default development credentials (defined only in `infra/docker-compose.dev.yml`
and `.env.example` — never used outside local development):

- Database: `datadiet`
- User: `datadiet`
- Password: `datadiet_dev_password`
- Port: `3306`

## Commands (PowerShell, from repository root)

```powershell
# Create a new migration after changing models (from backend/)
Set-Location backend
..\.venv\Scripts\alembic revision --autogenerate -m "describe change"

# Apply all migrations
..\.venv\Scripts\alembic upgrade head

# Inspect current revision
..\.venv\Scripts\alembic current

# Roll back one revision (use deliberately)
..\.venv\Scripts\alembic downgrade -1
```

Autogenerate compares models against the live database and fails loudly when
the database is unreachable — it does not silently create production tables.

## Phase 1 status

- Migration `0001_initial_schema` creates all foundation tables (sources,
  inventory, risk assessments, policies, holds, lifecycle actions, archives,
  retrieval requests, audit events, user directory placeholder).
- No seed data is written by migrations. Synthetic demo data is served
  in-process by the API (`/api/v1/demo/*`) and never touches MySQL.
