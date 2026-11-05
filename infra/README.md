# Infrastructure

Development infrastructure for DataDiet. Production deployment is described in
`docs/architecture.md`; the Nginx config here is a starting point only.

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
