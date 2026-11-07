# Azure deployment runbook

The ordered procedure for taking [infra/azure/](../infra/azure/) from templates
to a running staging environment, then to production.

> **Nothing in this document has been executed.** There is no Azure access in
> the authoring environment, so every command below is written for an operator
> to run and to correct where reality differs. The numbered
> [validation gate](#11-readiness-gates) at the end is what turns "documented"
> into "verified" — do not mark a step done because the command looked right.
>
> Design rationale and the list of open blockers:
> [docs/azure-architecture.md](azure-architecture.md). Day-to-day local
> workflow: [docs/setup.md](setup.md).

---

## 1. Prerequisites and permissions

### 1.1 Needed before anything runs

| Item | What it is | Who provides it |
| --- | --- | --- |
| Subscription + resource group | Two of each: staging and production. The templates are resource-group scoped and **do not create the group** | Operator, out of band |
| Region | One that supports App Service Linux, MySQL Flexible Server, Static Web Apps, and private endpoints together — verify, do not assume | Operator decision (`location`) |
| `nameToken` | 3–10 lowercase alphanumerics, unique enough for the four globally unique names | Operator decision |
| Bootstrap Key Vault | Holds the MySQL admin password *at deploy time*, before the environment vault exists | Operator |
| GitHub environments | `staging` and `production`, with required reviewers on `production` | Repo admin |
| Entra workload identity | App registration + federated credential per environment (below) | Operator, with consent |
| Custom domain (optional) | DNS zone the institution controls | Network/DNS owner |

### 1.2 GitHub OIDC trust (no repository secrets)

For each environment, create an application registration and one federated
credential whose **issuer** is GitHub's and whose **subject** is exactly:

```
repo:<owner>/<repo>:environment:staging
repo:<owner>/<repo>:environment:production
```

Issuer: `https://token.actions.githubusercontent.com` (verify the value for your
enterprise's runner region). Then grant that service principal, **at resource
group scope only**:

- `Contributor` — to create/update App Service, Static Web Apps, MySQL, vault,
  and their children;
- access to the **bootstrap** vault, so ARM can resolve the parameter file's
  `"reference": {"keyVault": ...}` for the MySQL admin password. Azure's
  documented requirement for that is
  `Microsoft.KeyVault/vaults/deploy/action`; on an RBAC-protected vault the
  fetching identity may also need data-plane secret read. Which exact grant the
  bootstrap vault needs is **unverified here** — resolve it on the first staging
  deployment and record the answer (deploy-time only, and the new environment
  vault is never granted to CI);
- `User Access Administrator` or an owner delegate — to write the
  `Key Vault Secrets User` role assignment on the new vault. If you would rather
  not grant it, create the role assignment by hand after the deployment.

Scoping the role assignment to the resource group is the least-privilege option;
subscription-level roles are not required by anything in this repository.

Then set these **environment variables** (Settings → Environments → \<env\> →
Variables — they are not secrets and are visible in logs):

| Name | Example shape | Used by |
| --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | `/subscriptions/...` value | `azure/login`, every `az` call |
| `AZURE_TENANT_ID` | GUID | `azure/login` |
| `AZURE_CLIENT_ID` | the federated app's client id | `azure/login` |
| `AZURE_RESOURCE_GROUP` | `datadiet-staging-rg` | deployment + webapps-deploy |
| `AZURE_BACKEND_APP_NAME` | `datadiet-staging-api-<token>` | `deploy-backend` |
| `AZURE_STATIC_WEB_APP_NAME` | `datadiet-staging-web-<token>` | `deploy-frontend` (site name **and** deployment-token source) |
| `DATADIET_API_BASE_URL` | `https://<backend host>` | frontend build arg `VITE_API_BASE_URL` |

The parameter file is **not** a variable: `preflight` maps the chosen
`environment` input to `infra/azure/params/dev.parameters.json` (staging) or
`prod.parameters.json` (production), so a dispatch cannot point at an arbitrary
template.

The `preflight` job refuses to run any deploy job unless all required names are
present, so a missing value is a clean failure rather than a half-deployment.

### 1.3 What the workflow deliberately cannot do

`.github/workflows/azure-deploy.yml` will not, by design:

- run Alembic ([section 7](#7-database-migrations-controlled-not-automatic));
- write a secret value anywhere;
- deploy without `workflow_dispatch` (no push trigger, no schedule);
- reach production without the environment's required-reviewer approval;
- create or delete a resource group, database, or vault (the deployment is
  `--mode Incremental`, and **deletes are never performed automatically** —
  see [section 9](#9-rollback-and-recovery)).

## 2. Validate the templates (before the first deployment)

Offline, no credentials:

```powershell
az bicep install
az bicep build --file infra/azure/main.bicep --outdir build/
az bicep lint  --file infra/azure/main.bicep
# repeat for every file in infra/azure/modules/
python -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" infra/azure/params/dev.parameters.json
```

Online, against a scratch resource group (creates nothing):

```powershell
az deployment group what-if --resource-group <rg> `
  --template-file infra/azure/main.bicep `
  --parameters @infra/azure/params/dev.parameters.json
az deployment group validate --resource-group <rg> `
  --template-file infra/azure/main.bicep `
  --parameters @infra/azure/params/dev.parameters.json
```

Work through the *Unverified items* table in
[infra/azure/README.md](../infra/azure/README.md) as errors appear, and record
each correction in the template — do not patch it only in the live resource.
Expect to change at least: the MySQL api-version, the private-endpoint group id,
the private DNS zone suffix, `PYTHON|<version>`, and the static-site properties.

## 3. Provisioning sequence

1. Fill the parameter file: replace every `<ANGLE_BRACKET>` placeholder and
   resolve every `DECIDE:` marker. **A placeholder left in place must fail the
   deployment** — that is the intended behaviour, not a bug.
2. Confirm the MySQL admin password comes from the bootstrap vault via
   `"reference": {"keyVault": {"id": "..."}, "secretName": "..."}`. Never put a
   value in the file; the parameter is `@secure()` so ARM does not log it.
3. Run the deploy workflow with `environment=staging`, `deploy_infrastructure=true`.
4. Read the stack outputs — `backendUrl`, `frontendUrl`, `keyVaultName`,
   `mysqlFullyQualifiedDomainName`, `mysqlPort`,
   `backendManagedIdentityPrincipalId`, `suggestedCorsOrigins`. They are the
   inputs to the next three sections.
5. Populate secrets ([section 4](#4-secrets-and-managed-identity)).
6. Create the least-privilege database users
   ([section 6](#6-database-tls-network-backup-and-restore)).
7. Run migrations ([section 7](#7-database-migrations-controlled-not-automatic)).
8. Deploy the backend, then the frontend ([section 8](#8-application-deployment)).
9. Smoke-test and verify ([section 10](#10-staging-smoke-tests-and-verification)
   and [section 11](#11-readiness-gates)).

Order matters: the vault is created empty, so a backend deployed before the
secrets exist starts with unresolved Key Vault references. It will not crash the
platform, but `/api/v1/health/ready` will stay degraded — which is exactly what
the readiness gate is for.

## 4. Secrets and managed identity

The template grants the backend's user-assigned identity **Key Vault Secrets
User** on the vault and nothing else. Verify, then populate:

```powershell
az role assignment list --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault> -o table
# expect exactly one assignment: the backend identity, "Key Vault Secrets User"

az keyvault secret set --vault-name <vault> --name datadiet-database-url `
  --value "mysql+pymysql://<runtime-user>:<password>@<mysql-fqdn>:3306/datadiet?<TLS options — section 6>"
az keyvault secret set --vault-name <vault> --name datadiet-auth-jwt-secret `
  --value (python -c "import secrets; print(secrets.token_urlsafe(48))")
```

Two runtime secrets, deliberately named by the template's
`databaseUrlSecretName` / `authJwtSecretName` parameters. The Static Web Apps
deployment token is **not** a third one: CI reads it straight from the site
([section 5](#5-frontend-deployment-and-the-swa-token)), so the deployment
identity needs no Key Vault data-plane role at all.

Rules that hold in every environment:

- No secret value is ever echoed into a terminal history file, an issue, a CI
  log, or a commit. `az ... -o tsc` on a secret is a deliberate, single-purpose
  exception; treat the shell line as sensitive.
- `AUTH_JWT_SECRET` must be ≥32 characters in production — shorter is refused at
  startup, absent is 503 fail-closed. Do not "fix" a 503 by reusing a dev value;
  `production-readiness.md` section 2 is the authority on rotation.
- The application-setting references are **unversioned**
  (`@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>)`),
  so a new secret version is picked up within ~24 hours without a redeploy.
  Pin a version only when you need an immediate, controlled cutover.
- If the vault is reachable only privately, the Key Vault references cannot
  resolve until App Service VNet integration exists. This is blocker **B4**;
  `keyVaultReferenceIdentity` is already set to the user-assigned identity.

## 5. Frontend deployment and the SWA token

Two supported shapes, decided by `buildFromSource` in
[modules/frontend.bicep](../infra/azure/modules/frontend.bicep):

- **Prebuilt (default)** — CI builds `frontend/dist` with
  `VITE_API_BASE_URL` and uploads it with the SWA CLI using the site's
  deployment token, fetched over the management plane inside the same step that
  uses it:
  `az staticwebapp secrets list --name <swa> --resource-group <rg> --query properties.apiKey -o tsv`.
  The value is `::add-mask::`'d immediately and never written to `GITHUB_ENV`, a
  job output, an artifact, or a file. No permanent GitHub credential lives on
  the Azure resource, and the CI identity needs no Key Vault data-plane role.
- **Build-from-source** — SWA builds from the repository, which stores a GitHub
  token/APP on the resource. Choose it only if you accept that credential and
  have reviewed how it is rotated.

Stage slot: `stagingEnvironmentPolicy: Enabled` gives a preview URL per
deployment — use it for the verification pass, then promote the staged
deployment to `production` (`az staticwebapp` / the SWA CLI or the portal, per
the current guidance) and confirm the promotion in the portal. Keep the
Free-vs-Standard consequences in mind: on `Free`, custom domains and some
staging behaviour are limited.

## 6. Database: TLS, network, backup and restore

### 6.1 TLS

`modules/mysql.bicep` sets, as `configurations` children:

- `require_secure_transport = ON`
- `tls_version = TLS 1.2` (or `TLS 1.3`)
- `character_set_server = utf8mb4`, `collation_server = utf8mb4_0900_ai_ci`

The application passes no `connect_args`
([backend/app/db/session.py:21](../backend/app/db/session.py#L21)), so **TLS is
configured entirely by the `DATABASE_URL` query string.** Verify the first real
connection explicitly, and record which form worked:

```powershell
# from the site console (SCM -> Bash), i.e. the exact image the app runs in
python -c "
import os
from sqlalchemy import create_engine, text
with create_engine(os.environ['DATABASE_URL'], pool_pre_ping=True).connect() as c:
    print(c.execute(text('SELECT VERSION()')).all())
    print(c.execute(text(\"SHOW STATUS LIKE 'Ssl_cipher'\")).all())
    print(c.execute(text(\"SHOW VARIABLES LIKE 'require_secure_transport'\")).all())
"
```

`Ssl_cipher` empty means the connection is plaintext despite
`require_secure_transport=ON` — in that case the server should have rejected it,
so investigate before concluding anything. Candidate forms to test (do not
presume one works):

```
mysql+pymysql://user:pw@host:3306/datadiet?ssl_ca=/etc/ssl/certs/ca-certificates.crt
...?ssl_ca=/etc/ssl/certs/ca-certificates.crt&ssl_verify_cert=true&ssl_verify_identity=true
```

Azure Flexible Server certificates and their rotation are a documented
server-side property — check the current guidance for the region and cloud you
are in rather than copying a CA path from this file.

### 6.2 Network

Pick `mysqlNetworkMode` knowing it is **immutable** after creation:

| Mode | Also required |
| --- | --- |
| `public` | `mysqlFirewallRules` pinned to the plan's outbound addresses (`az appservice plan show` → `outboundIpList`, or the site's *Possible inbound/outbound IP addresses*). They are shared and can change — treat this as firewalled, not private |
| `private-endpoint` | VNet + private DNS zone (templated) **and** App Service VNet integration (not templated) |
| `delegated` | `/28` subnet delegated to `Microsoft.DBforMySQL/flexibleServers` **and** VNet integration |

VNet integration, done deliberately and then re-verified:

```powershell
az webapp vnet-integration create --name <site> --resource-group <rg> `
  --vnet <vnet> --subnet <integration-subnet>
az webapp vnet-integration list --name <site> --resource-group <rg>
```

Integration traffic needs the route-table/NSG rules MySQL expects
(`Microsoft.Storage`/`vnet` service endpoints per the Flexible Server docs for
your version). Resolve DNS from inside the site before believing the path works:

```powershell
python -c "import socket; print(socket.getaddrinfo('<mysql-fqdn>', 3306))"
```

### 6.3 Backup and restore

- `backupRetentionDays` (parameter, default 7) and `geoRedundantBackup`
  (parameter, default `false` — it roughly doubles backup storage cost) are the
  whole policy in the template. Point-in-restore is a server property; confirm
  its window in the portal or via `az mysql flexible-server backup`.
- Manual backup before any migration or risky change:
  `az mysql flexible-server backup create --server-name <s> --resource-group <rg> --backup-name pre0013`
- Restore is **never** automatic and never to the same name. Use a scratch
  server or a `--restore-to-server` target, verify, then decide:
  `az mysql flexible-server restore --source-server-name <s> --resource-group <rg> --restore-time "<UTC>" --target-server-name <scratch> ...`
- Logical export for evidence and portability, consistent with
  [docs/backup-restore.md](backup-restore.md): `mysqldump --single-transaction
  --set-gtid-purged=OFF` against a maintained replica, never against production
  during business hours without approval.
- The restore drill documented in `docs/backup-restore.md` was executed on a
  **local disposable MySQL**, not on Azure. Its 21/21 table-checksum result does
  not transfer to Azure until re-run there; treat "Azure restore verified" as
  unchecked in the cutover list.

## 7. Database migrations: controlled, not automatic

Migrations stay exactly as [docs/setup.md](setup.md) section 8 defines them:
read-only preflight → human review → maintenance window → apply → verify →
re-grant. Azure changes the connection target, not the governance (ADR-0018).

```powershell
Set-Location backend
# 1. credential-free target + revision report; refuses non-MySQL dialects
..\.venv\Scripts\python.exe ..\scripts\migration_preflight.py
# 2. reviewed by a named person, in a ticket, with the revision list attached
# 3. apply — an operator session, never a pipeline
..\.venv\Scripts\alembic.exe upgrade head
..\.venv\Scripts\alembic.exe current
```

Rules:

1. No CI/CD workflow runs Alembic. The deploy workflow's `preflight` job prints
   "never runs Alembic" as an assertion of that rule, not a TODO.
2. Take a manual backup first ([section 6.3](#63-backup-and-restore)).
3. Database roles: ARM cannot run in-database DML, so least privilege is a
   manual step (blocker **B7**). Create at minimum —
   - a **migration** user with `CREATE, ALTER, INDEX, DROP, REFERENCES, LOCK
     TABLES, CREATE TEMPORARY TABLES` plus DML on the application schema;
   - a **runtime** user with DML only (`SELECT, INSERT, UPDATE, DELETE`), no
     DDL, no `SUPER`/`PROCESS`.
   Store each in Key Vault under its own secret name; put the runtime user in
   `DATABASE_URL`. Document the outcome, not just the commands.
4. Rollback boundary is `0005` (ADR-0016); `0012` is forward-only evidence
   (ADR-0020). Never downgrade a durable database as a shortcut.
5. The supported migration test path remains the disposable loopback MySQL with
   `MIGRATION_TEST_ALLOW_DROP=1` + `MIGRATION_TEST_DB_URL` — 19 tests, run by
   `ci.yml`, not against the Azure server.

## 8. Application deployment

```
build  ──► deploy-infrastructure ──► deploy-backend ──► deploy-frontend ──► smoke-test
           (gated on inputs,                (zip)          (prebuilt)        (read-only)
            protected env)
```

- The backend artifact is zipped **from `backend/`** so `requirements.txt` and
  `app/main.py` sit at the package root; the workflow asserts both, because Oryx
  silently skips dependency installation otherwise.
- `webapps-deploy` runs with `clean: true` so a stale file cannot linger between
  releases.
- `deploy-backend` waits for `/api/v1/health` (liveness, no database) to return
  200 before finishing; readiness is checked separately and *reported, not
  asserted*, because a degraded database is a real state an operator needs to
  see rather than a red X that hides it.
- The frontend build receives `VITE_API_BASE_URL` from the environment variable,
  never from a committed `.env`.

## 9. Rollback and recovery

| Failure | Action | Notes |
| --- | --- | --- |
| Bad backend release | Re-run `deploy-backend` with the last known-good build artifact (or the previous release's package) | Retain the last known-good artifact — Azure zip deployment does not keep a rollback history you can rely on; slot swap needs a second site config not templated here |
| Bad infrastructure change | Re-run the deployment with the previous **parameter file and template commit** (Incremental mode). Review `what-if` output first | Incremental never deletes resources; a property that must revert may need an explicit `az` change or a re-created resource — decide in a ticket, don't automate a destroy |
| Failed migration | Follow `docs/setup.md` section 8.5 and ADR-0016's boundary; restore from the pre-migration backup if the downgrade is unsupported | **Never** `downgrade base` on a durable database |
| Data loss / corruption | Restore to a scratch server ([section 6.3](#63-backup-and-restore)), verify checksums, then decide on cutover to the restored server | Point-in-time restore is a new server, not an in-place rewind |
| Region or platform outage | DR is **not** provisioned: no second region, no geo-redundant backup by default, no HA | An explicit, costed decision, not an oversight |
| Vault purge | Purge protection is enabled in the template; recovery needs an approval flow | Soft-delete 90 days |

Automatic deletion is not implemented anywhere in this repository and will not
be added (AGENTS.md rule 1). Every destructive recovery step above is a human
decision recorded in a ticket.

## 10. Staging smoke tests and verification

Run against staging first, in this order, and keep the output as evidence:

| # | Check | Expected | Meaning |
| --- | --- | --- | --- |
| 1 | `GET /api/v1/health` | 200 + `environment` | Process is up; the value must read `production` when `ENVIRONMENT=production` |
| 2 | `GET /api/v1/health/ready` | 200 `ready` | The database path (TLS, network, credentials) actually works |
| 3 | `GET /api/v1/auth/config` | 200 | Public on purpose; must **not** report `dev_login_enabled: true` in production |
| 4 | `POST /api/v1/auth/dev-login` | **not 2xx** | Fail-closed: production answers 503 when unconfigured, 403/404 otherwise — asserting 401 would be wrong |
| 5 | `GET /api/v1/users` without a token | non-2xx | Protected surfaces stay closed |
| 6 | `GET /` (root) | 200 | CORS/root wiring intact |
| 7 | Browser origin check | preflight allowed only for configured origins | CORS is pinned to the SWA origin / custom domain |
| 8 | Frontend `https://<swa>` | loads and calls the API | `VITE_API_BASE_URL` was baked correctly |
| 9 | Synthetic demo endpoints when `demoDataEnabled=false` | 404/absent | No demo surface on a reachable deployment |
| 10 | App Service logs (stream) + `audit_events` rows after a signed-in action | visible | Observability claim, see below |

The `smoke-test` job performs a read-only subset (1, 3, 5, and a production
`ENVIRONMENT` assertion) and prints readiness without asserting it. Items 2, 4,
7-10 need credentials or a browser and are **operator steps** — do not mark them
verified because CI is green.

Monitoring, honestly: the application emits **no Application Insights
telemetry** today (no OpenTelemetry/Azure Monitor agent in the code). The
optional component in `modules/monitoring.bicep` only gives you a destination.
Log access is: App Service → *Logs* / `az webapp log tail` (filesystem logs
under `/home/logs`), plus the append-only `audit_events` table in MySQL, which
is the real audit trail. Named ownership of these — who may read them, who is
paged — is an institutional decision recorded in
[docs/azure-cutover-checklist.md](azure-cutover-checklist.md), not something a
template can assign.

## 11. Readiness gates

Nothing is "deployed to production" until all of these are true and evidenced.
The expanded list with owner columns is the cutover checklist.

| Gate | Status now |
| --- | --- |
| `az bicep build` + `az bicep lint` clean for `main.bicep` and every module | ☐ never run |
| `what-if`/`validate` reviewed and approved | ☐ never run |
| First staging deployment succeeds from the parameter file alone | ☐ never run |
| TLS to MySQL proven from inside the App Service image | ☐ blocker B3 |
| Database roles: migration vs runtime DML-only separation documented | ☐ blocker B7 |
| Backup + Azure-side restore drill re-executed | ☐ local only |
| Migration applied by a human in a maintenance window, preflight attached | ☐ n/a yet |
| Real identity provider implemented and tested | ☐ blocker B2 — production stays fail-closed |
| Actions pinned to commit SHAs; branch protection + required reviewers enabled | ☐ blockers B6 / repo settings |
| `docs/production-readiness.md` verdict updated by a person | ☐ still "not production-ready" |

## 12. DNS, custom domain, HTTPS

1. Frontend: `frontendCustomDomain` (parameter) creates the
   `Microsoft.Web/staticSites/customDomains` child; Azure then requires a
   **TXT validation record** before the certificate is issued. Add the CNAME/A
   record in the institution's DNS zone, wait for validation, then re-check.
2. Backend: App Service custom domains follow the same mapping-then-TXT
   pattern and are **not templated** (`modules/backend.bicep` does not create
   hostname bindings) — do it deliberately via `az appservice dns registration`
   / portal, then confirm `httpsOnly` is still true and the old
   `*.azurewebsites.net` hostname is either disabled or documented.
3. TLS: `minTlsVersion: 1.2` on both site config objects; the site is
   `httpsOnly: true`; `ftpsState: FtpsOnly`.
4. The frontend origin must then be added to `backendCorsOrigins`, which
   redeploys `CORS_ORIGINS`.
5. `production-readiness.md` section 4 (reverse-proxy trust) is still open:
   `--proxy-headers` is used and `--forwarded-allow-ips` is deliberately **not**
   widened to `*`. Custom-domain TLS termination changes that analysis — re-run
   it rather than assuming.

## 13. Post-deployment

- Update [docs/architecture.md](architecture.md)'s phase bullet and
  [docs/production-readiness.md](production-readiness.md) with what was actually
  observed — the AGENTS.md rule is that behaviour changes move the status table,
  and a template that merely exists is not a behaviour change.
- Record: region, resource names, SKUs, network mode, role assignments, secret
  names (never values), the `az bicep`/`what-if` output, and every correction
  made to the templates during the first run.
- Then schedule the things this document cannot do for you: rotate the MySQL
  admin password out of the bootstrap vault, disable the staging dev-login
  provider if it was ever enabled, and set alerting on
  `/api/v1/health/ready` + audit-log volume.
