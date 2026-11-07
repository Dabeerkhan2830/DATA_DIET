# Azure migration — architecture and gap analysis

**Scope of this document.** The design and the honest current state of preparing
DataDiet for Microsoft Azure. It was written **without Azure credentials**: no
subscription, tenant, resource group, region, or hostname was assumed, and
nothing in this repository has been deployed, compiled by a Bicep compiler, or
`what-if` validated. Read the three-way status split in
[section 8](#8-implemented--templated--unverified) before acting on anything
here.

Related: [infra/azure/README.md](../infra/azure/README.md) (template layout,
naming, validation commands, unverified-items table),
[docs/azure-deployment.md](azure-deployment.md) (the runbook),
[docs/azure-cutover-checklist.md](azure-cutover-checklist.md) (the gate),
[docs/production-readiness.md](production-readiness.md) (production blockers
that Azure does not solve by itself).

---

## 1. Migration gap analysis

### 1.1 Findings

| # | Finding | Evidence | Consequence for Azure |
| --- | --- | --- | --- |
| F1 | **Fixed: the shipped `CORS_ORIGINS` form crashed settings load.** With `pydantic-settings` 2.16, a `list[str]` field is JSON-decoded *inside* the env/dotenv source, before any validator runs, so `CORS_ORIGINS=http://localhost:5173` — the value `.env.example` shipped — raised `SettingsError: error parsing value for field "cors_origins" from source "DotEnvSettingsSource"`. Reproduced with the comma form and the single-origin form; only a JSON array was accepted. | [backend/app/core/config.py:53-57](../backend/app/core/config.py#L53), [backend/tests/test_config_cors_origins.py](../backend/tests/test_config_cors_origins.py) | App Service application settings can only carry flat strings, so this was a **hard startup blocker for any Azure deployment**, not a style issue. `cors_origins` is now `Annotated[list[str], NoDecode]` and the validator accepts the comma form *and* the JSON form; the dependency floor is `pydantic-settings>=2.7` (first release exporting `NoDecode`). |
| F2 | The application's configuration surface is small and fully enumerable. | [backend/app/core/config.py:44-93](../backend/app/core/config.py#L44) | The Bicep backend module writes exactly those keys and nothing else (see [section 5](#5-configuration-contract)). |
| F3 | `API_HOST`, `API_PORT`, `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` in `.env.example` are read by **no application code**; the MySQL container variables are literals inside `infra/docker-compose.dev.yml`, and uvicorn takes `--port` on the command line. | `grep` over `backend/`, `frontend/`, `scripts/`, `infra/`, `.github/` | They must not be presented as deployment configuration. `.env.example` now says so, and the Azure start command comes from `appCommandLine` in [infra/azure/modules/backend.bicep](../infra/azure/modules/backend.bicep), not from a phantom `API_PORT`. |
| F4 | TLS to MySQL is configured **only** through the `DATABASE_URL` query string: `create_engine()` passes no `connect_args`. | [backend/app/db/session.py:21-26](../backend/app/db/session.py#L21) | The template sets `require_secure_transport=ON`. A connection string without PyMySQL TLS options is therefore an open question for the first real deployment — see blocker **B3**. |
| F5 | Probes exist and are split correctly: `GET /api/v1/health` never touches the database; `GET /api/v1/health/ready` answers 503 `degraded` when it cannot run `SELECT 1`. | [backend/app/api/routes/health.py:16-43](../backend/app/api/routes/health.py#L16) | `/api/v1/health` is the App Service health-check path (it must not fail while the database is restarting); readiness is the *deployment* gate. |
| F6 | Authentication is HS256-only, verified in-process, and **fails closed**: in `ENVIRONMENT=production` a missing or development-placeholder secret empties `auth_jwt_secret`, every protected endpoint answers 503, and `dev-login` is disabled by code, not by configuration. | [backend/app/core/config.py:120-157](../backend/app/core/config.py#L120), [backend/app/core/auth.py](../backend/app/core/auth.py), ADR-0014 | Azure provisioning cannot make this deployment "authenticated". Key Vault + managed identity solve *secret storage*, not *identity*. No OIDC claim is made anywhere. |
| F7 | Alembic is credential-free in the repo (`sqlalchemy.url =` empty; `database/migrations/env.py` takes the URL from settings) and the operator runbook is already written with human gates. | [backend/alembic.ini](../backend/alembic.ini), [docs/setup.md](setup.md) section 8, ADR-0018 | Migration stays a reviewed, manual step. No workflow in this repository runs Alembic against a durable database. |
| F8 | The frontend takes exactly one public variable, `VITE_API_BASE_URL`, and Vite's `envDir` is the **repository root**. | [frontend/src/api/client.ts](../frontend/src/api/client.ts), [frontend/vite.config.ts](../frontend/vite.config.ts) | Only `VITE_*` reaches the bundle, but a root `.env` is the file Vite reads — so that file is *not* a safe place for a `VITE_` value that happens to be secret. The Azure workflow injects `VITE_API_BASE_URL` as a build argument from the environment, not from a committed file. |
| F9 | There is no Dockerfile or container image; CI runs on GitHub-hosted Linux and the full local gate (`scripts/check.ps1`) is Windows PowerShell 5.1. | [scripts/check.ps1](../scripts/check.ps1), [.github/workflows/ci.yml](../.github/workflows/ci.yml) | The default Azure shape is **App Service Linux + Oryx zip deployment** (`SCM_DO_BUILD_DURING_DEPLOYMENT=true`, `PYTHON \| <version>`), so the artifact must contain `requirements.txt` and `app/` at its root. The workflow asserts both before upload. A container alternative is documented, not built. |
| F10 | The repo copy this work was done in is **not a git repository** (no `.git`), and `node`/`npm`, `az`, and `bicep` are unavailable; `github.com` and the Bicep download are unreachable from this environment, while `pypi.org` and Microsoft Learn are. | probed at authoring time | "Preserve every existing user change" reduces to *do not clobber*: all CI/doc edits are additive and `ci.yml` is untouched. Frontend typecheck/Vitest/build and all Bicep validation **could not run** and are reported as not run. |

### 1.2 Assumptions

1. Target shape is the one the user brief names: Static Web Apps (frontend) +
   App Service Linux/Python (backend) + Azure Database for MySQL Flexible Server
   (database) + Key Vault (secrets) — not Kubernetes, not containers-as-default.
2. MySQL stays MySQL. `DATABASE_URL` is a `mysql+pymysql://` SQLAlchemy URL and
   the migration suite is MySQL-specific; no SQLite/dialect change was made or
   is implied.
3. Dev and prod live in separate resource groups (ideally separate
   subscriptions) and never share a vault, database, or identity.
4. Token *verification* keeps its current contract: an external party issues
   HS256 bearer tokens to the same issuer/audience until RS256/JWKS is
   implemented and tested.
5. Everything currently labelled synthetic demo data remains synthetic; a
   network-reachable deployment should turn `DEMO_DATA_ENABLED` off.

### 1.3 Blockers

| ID | Blocker | Kind | Owner / gate |
| --- | --- | --- | --- |
| B1 | No Azure subscription, service principal, or workload-identity federation exists. Consequently the Bicep templates have never been parsed (`az bicep build`), linted, or `what-if` validated. | Hard, external | Needs Azure access + a validation run per [infra/azure/README.md](../infra/azure/README.md). Until then the templates are a reviewed proposal. |
| B2 | No real identity provider is implemented (HS256 only). Production authentication therefore fails closed by design; a running Azure backend is not a usable production service. | Hard, code | [docs/production-readiness.md](production-readiness.md) section 1. Do not describe the deployment as production-ready. |
| B3 | MySQL TLS client behaviour is unverified: `create_engine()` passes no `connect_args`, so whether PyMySQL completes a TLS handshake against a Flexible Server with `require_secure_transport=ON` depends on the exact `DATABASE_URL` options and the CA bundle in the App Service image. | Hard, needs a real server | First staging deployment; see [docs/azure-deployment.md](azure-deployment.md) section 4. |
| B4 | App Service **VNet integration is not templated** (the `Microsoft.Web/sites/config` virtual-network child shape could not be verified offline). Until it exists, the backend cannot reach a private-endpoint or delegated MySQL server, and Key Vault references in application settings cannot resolve against a firewalled/private vault. | Hard, networking | Documented CLI step in [docs/azure-deployment.md](azure-deployment.md) section 4; `params/prod.parameters.json` records the gap. |
| B5 | Frontend validation (typecheck, Vitest, production build) has not run in this environment — no `node`/`npm`, no `node_modules`. | Verification only | `npm ci && npm run typecheck && npm test && npm run build`, or `.github/workflows/ci.yml` once pushed. |
| B6 | GitHub Actions in `azure-deploy.yml` are pinned to version tags, not commit SHAs, because `github.com` was unreachable and SHAs could not be verified. That violates the repository's own convention (ADR-0019). | Hard, before enabling | Pin to full SHAs; see the `TODO(pin)` markers in the workflow. Inventing SHAs is not an option. |
| B7 | Least-privilege database roles (separate migration vs. runtime user) are not created by the template — ARM cannot run in-database DML. | Hard, manual | [docs/azure-deployment.md](azure-deployment.md) section 5. |

Nothing in this list was worked around by weakening a check, a secret rule, or
the fail-closed auth behaviour.

---

## 2. Current (verified) vs target architecture

| Layer | Today, in code | Azure target | Change needed |
| --- | --- | --- | --- |
| Frontend | React 19 + TS + Vite 6, `tsc -b && vite build` → `frontend/dist`; dev proxy `/api` → `127.0.0.1:8000` | Azure Static Web Apps, prebuilt artifact uploaded by CI | None to the app. `VITE_API_BASE_URL` at build time; optional custom domain |
| Backend | FastAPI served by uvicorn from `backend/`, `ENVIRONMENT`-driven settings | App Service Linux/Python, Oryx build-on-deploy, `appCommandLine` start | None to the app; F1 fixed the settings blocker |
| Database | MySQL 8.4 via docker-compose (dev), Alembic through `0012` | MySQL Flexible Server, TLS enforced, PITR backups | TLS options in `DATABASE_URL` (B3); network mode decision |
| Secrets | Local `.env` at repo root | Key Vault + App Service references, resolved by a user-assigned managed identity | New, templated; vault created empty on purpose |
| Identity | HS256 bearer verified in-process; synthetic dev-login | Unchanged (B2) | None — Azure does not provide this |
| Observability | Structured nothing: stdout, `/health`, append-only `audit_events` table | Optional workspace-based Application Insights | Off unless an existing workspace is named; **the app emits no AI telemetry today** |
| CI | `ci.yml` (six checks + 19 live MySQL migration tests) | Preserved untouched; `azure-deploy.yml` added separately | New workflow, never run |

## 3. Target resource topology

```
Resource group  datadiet-<environment>-rg                (operator-created)
├── Microsoft.ManagedIdentity/userAssignedIdentities     datadiet-<env>-api-id
├── Microsoft.KeyVault/vaults                            datadiet<env>kv<token>      (empty, RBAC, soft-delete 90d, purge protection)
├── Microsoft.DBforMySQL/flexibleServers                 <prefix><env>mysql<token>   (public | private-endpoint | delegated)
│     ├── databases/datadiet
│     ├── configurations  require_secure_transport=ON, tls_version, utf8mb4
│     └── firewallRules / privateEndpoint
├── Microsoft.Web/serverFarms                            datadiet-<env>-plan         (linux, reserved)
├── Microsoft.Web/sites                                  datadiet-<env>-api-<token>  (app,linux · httpsOnly · TLS 1.2 · FtpsOnly · /api/v1/health)
│     ├── config/web                                     linuxFxVersion, appCommandLine, healthCheckPath
│     └── config/appsettings                              KEY VAULT REFERENCES, never values
├── Microsoft.Web/staticSites                            datadiet-<env>-web-<token>  (Free | Standard, staging enabled)
├── Microsoft.Network/virtualNetworks (+ private DNS zones/links)   only when a private mode is chosen
└── Microsoft.Insights/components                        only when an existing workspace is named
```

Single entry point [infra/azure/main.bicep](../infra/azure/main.bicep) at
`targetScope = 'resourceGroup'`, with one module per concern under
`infra/azure/modules/` and dev/prod parameter files under
`infra/azure/params/`. The resource group itself is **not** templated (creating
it is an explicit operator action, which keeps subscription and region choice
outside the template).

Deliberately absent, and why, is stated in the header of `main.bicep`:
secret values, Alembic execution, App Service VNet integration, and a Log
Analytics workspace.

## 4. Networking options

`mysqlNetworkMode` is immutable after creation — choose per environment,
knowing that changing it means destroying and recreating the server.

| Mode | Path from backend to database | Cost | Status |
| --- | --- | --- | --- |
| `public` | Internet/Backfill, gated by `mysqlFirewallRules` pinned to the App Service plan's outbound IPs (shared, and they can change) | none extra | Templated; the only mode that works end-to-end today |
| `private-endpoint` | NIC in the VNet + `privatelink.mysql.database.azure.com` | per endpoint/month + DNS | Templated, **unreachable from the backend until B4 is resolved** |
| `delegated` | Server inside a `/28` subnet delegated to `Microsoft.DBforMySQL/flexibleServers` | subnet capacity only | Templated, same B4 gap |

Key Vault follows the same rule (`keyVaultPrivateAccess`): a private vault is
only usable for application-setting references once the backend has a network
path to it. The vault therefore defaults to `publicNetworkAccess: 'Enabled'`
with `networkAcls.bypass: 'AzureServices'` and an operator-supplied IP
allowlist; `keyVaultAllowPublicAccess=false` combined with no VNet integration
is a self-inflicted outage and is called out in
[params/prod.parameters.json](../infra/azure/params/prod.parameters.json).

A VNet is created only when `needsVnet` or `needsPrivateEndpoints` is true, so a
development-shaped deployment pays for no networking at all.

## 5. Configuration contract

These are the keys the code actually reads ([backend/app/core/config.py](../backend/app/core/config.py)),
what each means, and where an Azure deployment puts it. Nothing here is
aspirational: a key not in this table is not a supported setting.

| Setting | Read by | Accepted form | Azure source |
| --- | --- | --- | --- |
| `ENVIRONMENT` | settings, auth fail-closed logic, `/auth/config` | `development` \| `test` \| `production` | app setting, derived from the `environment` parameter (`prod` → `production`) |
| `DATABASE_URL` | `get_engine()`, Alembic | SQLAlchemy URL; must contain `://` | **Key Vault reference** |
| `DATABASE_ECHO` | engine | bool | app setting, `false` |
| `CORS_ORIGINS` | `CORSMiddleware` in `app/main.py` | comma-separated **or** JSON array (F1) | app setting, comma-joined from `backendCorsOrigins` |
| `DEMO_DATA_ENABLED` | demo router gate | bool | app setting from `demoDataEnabled` (default `false`) |
| `LOCAL_SOURCE_ROOTS` | local-folder source allow-list | **JSON object** (a dict field is JSON-decoded before validators — the comma form is *not* valid here) | backend-module default `'{}'`: App Service has no durable user filesystem, so local-folder sources stay disabled |
| `SCAN_MAX_RECORDS` / `SCAN_BATCH_SIZE` | scan service | int, bounds validated in code | backend-module defaults (`5000` / `500`), not exposed as top-level parameters |
| `AUTH_JWT_SECRET` | `issue_token` / verification | ≥32 chars in production, else startup is refused; absent ⇒ 503 | **Key Vault reference** |
| `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE` | token validation | string, must match the issuer | app settings |
| `AUTH_TOKEN_TTL_SECONDS` | token issue | int 60..86400 | app setting |
| `AUTH_DEV_PROVIDER_ENABLED` | dev-login gate | bool, **forced false in production by code** | app setting from parameter (default `false`) |
| `VITE_API_BASE_URL` | `frontend/src/api/client.ts` | public origin or empty | build-time env in CI; never a secret |

Platform-side, non-application settings written by the template:
`SCM_DO_BUILD_DURING_DEPLOYMENT`, the `appCommandLine` start command,
`healthCheckPath`, `minTlsVersion`, `ftpsState`, `alwaysOn`, `http20Enabled`,
`netStack`, and `APPLICATIONINSIGHTS_CONNECTION_STRING` (added only when
monitoring is enabled).

Production rules preserved without exception: HTTPS-only site, TLS 1.2
minimum, SFTP-only publishing, `allow_credentials=False` CORS with explicit
origins, no secret value in a template, parameter file, workflow, or log, and
`AUTH_DEV_PROVIDER_ENABLED` irrelevant in production because code strips it.

## 6. Identity and secret model

1. **Deploy-time** secret: `mysqlAdministratorLoginPassword`, `@secure()`,
   supplied through the parameter file's `reference.keyVault` block pointing at
   a bootstrap vault the operator already owns (needs
   `Microsoft.KeyVault/vaults/deploy/action`). It never appears in a file here.
2. **Runtime** secrets: `DATABASE_URL`, `AUTH_JWT_SECRET` — written by a human
   into the vault after provisioning. The backend resolves them through
   `@Microsoft.KeyVault(SecretUri=...)` *unversioned* references, so a rotation
   propagates within 24 hours (pin a version for immediate effect at the cost
   of a redeploy-per-rotation).
3. **Identity**: the site uses a user-assigned managed identity holding exactly
   **Key Vault Secrets User** (`4633458b-17de-408a-b874-0445c86b69e6`) on that
   vault. Nothing else is granted; there is no contributor role on the vault,
   no storage access, no subscription role.
4. **CI identity**: GitHub OIDC → a federated service principal scoped to the
   resource group (see [docs/azure-deployment.md](azure-deployment.md) section
   1). The repository stores **zero secrets**.
5. The Static Web Apps deployment token is **not** stored in the vault: CI reads
   it from the site over the management plane inside one step, masks it, and
   never writes it to a file, output, or later step. That keeps the deployment
   identity free of any Key Vault data-plane role.

## 7. Cost categories

No prices are quoted anywhere in this repository: they move, differ by region
and offer, and a template cannot pin them down. Budget by category, then price
the exact SKUs with the Azure calculator or `az` against your own agreement.

- App Service plan — SKU × instance count. `B1` has no Always On and no
  scaling: a development choice, not a production one.
- MySQL Flexible Server — compute SKU, storage size (growth is one-way),
  backup retention days, geo-redundant backup (≈2× backup storage),
  zone-redundant HA (≈2× compute).
- Static Web Apps — `Free` (no SLA, no private endpoints) vs `Standard`. The
  Dedicated plan was retired 2025-10-31; only these two remain.
- Private endpoints and private DNS zones — per endpoint per month + processed
  data; created only when a private mode is selected.
- VNet and subnets — free. Peering or a NAT gateway (not templated) — not free.
- Application Insights + Log Analytics — billed on **ingested and retained
  volume**, the item most likely to blow a budget; the module stays off unless
  an existing workspace id is supplied.
- Outbound data transfer.

Defaults are deliberately development-shaped (`B1` / `Burstable_B2s` / `Free`,
no HA, no geo-backup, no private endpoints, no monitoring).
`params/prod.parameters.json` marks each paid choice `DECIDE:` instead of
quietly selecting a tier on someone's behalf.

## 8. Implemented / templated / unverified

| Claim | Category |
| --- | --- |
| FastAPI app, settings validation incl. the CORS fix, fail-closed auth, health/readiness, Alembic through `0012`, audit trail | **Implemented and tested in code** |
| `infra/azure/**` (entry point, 7 modules, 2 parameter files), `.github/workflows/azure-deploy.yml`, this document, deployment runbook, cutover checklist | **Templated / authored — reviewed by hand, never executed** |
| Bicep compiles; lint is clean; the resource shapes, api-versions, enum strings, runtime ids, and role GUID are accepted by Azure | **UNVERIFIED** — needs `az bicep build`, `az bicep lint`, `az deployment group what-if` / `validate` |
| Frontend typecheck, Vitest, production build | **NOT RUN** here (no Node); `ci.yml` is configured to run them |
| `check.ps1` six-check gate | Backend ruff (app + scripts) and backend pytest **ran and passed**; frontend stages could not run |
| Any deployment, migration, real user sign-in, cost, or SLA outcome | **NOT PERFORMED and not claimed** |

The full list of specific technical assumptions still open — with the command
that resolves each — is the *Unverified items* table in
[infra/azure/README.md](../infra/azure/README.md).

## 9. Alternatives where the decision cannot be made yet

| Decision | Option A (what is templated) | Option B | Consequence |
| --- | --- | --- | --- |
| Frontend hosting | Static Web Apps, **prebuilt artifact from CI** | SWA build-from-source (GitHub token) or App Service/Azure Front Door/Storage | Build-from-source stores a permanent GitHub credential on the resource; `provider: 'External'` avoids that but leaves the repo/branch fields unverified offline. Both shapes are parameterised (`buildFromSource`) |
| Backend packaging | Zip + Oryx (`SCM_DO_BUILD_DURING_DEPLOYMENT`) | Custom Linux container (ACR + `containers`) | A container needs a Dockerfile, registry, and image scan — none exist; `production-readiness.md` section 9 lists this as its own gap |
| Database network | Public + pinned firewall rules | Private endpoint or delegation | Option B is strictly better but is blocked on B4 (VNet integration) |
| Secret consumption | App Service Key Vault references | CI fetches the secret and writes it as a plain setting | A leaves no secret in a settings blob but needs vault reachability; B puts the value in the site's app settings and needs a redeploy to rotate |
| Signing key | HS256 shared secret (today) | RS256 + JWKS (unimplemented) | Switching is a code change plus tests, not a configuration; B2 stays open |
| Deployment engine | GitHub Actions (`azure-deploy.yml`) | Azure DevOps / Bicep pipelines | Only the GitHub path is scaffolded; nothing else was added speculatively |

## 10. Explicit non-claims

This repository does **not** claim: a deployed Azure environment, validated
Bicep, a working OIDC sign-in, a hardened private network, tested TLS database
connections, measured cost, a passing frontend build in this environment, or
production readiness. `docs/production-readiness.md` remains the authority for
the blockers, and its verdict is unchanged by anything in this directory.
