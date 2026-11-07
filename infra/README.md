# Infrastructure

Development infrastructure for DataDiet. Production deployment is described in
`docs/architecture.md`; the Nginx config here is a starting point only.

| Path | What it is |
| --- | --- |
| `docker-compose.dev.yml` | Development MySQL + optional Nginx edge profile |
| `nginx/nginx.conf` | Future self-hosted edge placeholder (not used by the Azure shape) |
| `azure/` | Bicep templates for a future Azure deployment — **written, never deployed, never compiled** |
| `floci/` | Floci-AZ (Azure emulator) on Render: feasibility record + a drafted private-service definition — **prepared, never deployed, never run** |

## Azure

`azure/` is the infrastructure-as-code scaffolding for a planned Azure target
(Static Web Apps + App Service Linux + MySQL Flexible Server + Key Vault). Start
with `azure/README.md` for the layout, naming, cost categories, validation
commands, and the table of assumptions that still need Azure access to resolve;
`docs/azure-architecture.md`, `docs/azure-deployment.md`, and
`docs/azure-cutover-checklist.md` carry the design, runbook, and gate. Nothing
in it has been deployed, and it creates no cloud resources by itself.

## Floci-AZ emulator (Render)

`floci/` records what it would take to host the Floci-AZ Azure emulator as a
Render service for the backend to call. Read `floci/README.md` for the
compatibility matrix, the persistence and security risks, and the verification
checklist; `floci/render.yaml` is the drafted definition of the emulator as a
Render **private** service. Nothing here is wired into DataDiet — the application
uses no Azure storage API yet — and nothing has been deployed or run.

## Docker Compose (development)

`docker-compose.dev.yml` provides:

| Service | Purpose | Default port |
| --- | --- | --- |
| `mysql` | MySQL 8.4 development database | 3306 |
| `nginx` | Future deployment entry point (disabled behind the `edge` profile) | 8080 |

```powershell
# Start the database
docker compose -f infra/docker-compose.dev.yml up -d mysql

# Check it is healthy
docker compose -f infra/docker-compose.dev.yml ps

# Stop it (data is kept in the named volume)
docker compose -f infra/docker-compose.dev.yml down

# Stop it and delete all local data
docker compose -f infra/docker-compose.dev.yml down -v
```

## Nginx

`nginx/nginx.conf` serves the built frontend from `frontend/dist` and proxies
`/api/` to the FastAPI backend. It is a **future deployment placeholder** and is
not part of the development loop — in development, Vite proxies `/api` to
`http://localhost:8000` (see `frontend/vite.config.ts`).

To try it locally (requires Docker and `npm run build` in `frontend/`):

```powershell
npm --prefix frontend run build
docker compose -f infra/docker-compose.dev.yml --profile edge up -d
# Open http://localhost:8080
```

## Docker not installed?

That is fine for Phase 1. The backend health endpoint and all synthetic demo
endpoints work without MySQL; only `/api/v1/health/ready` reports degraded and
Alembic migrations require a reachable database.
