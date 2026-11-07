# Azure cutover checklist

A gate list, not a narrative. Every line is unchecked: **nothing in this file
has happened.** Work top to bottom; a blocked line stops the cutover rather
than getting waved through, and the evidence column says what "done" means.

Companion docs: [azure-architecture.md](azure-architecture.md) (design +
blockers), [azure-deployment.md](azure-deployment.md) (how to run each step),
[production-readiness.md](production-readiness.md) (the blockers Azure does not
remove), [../infra/azure/README.md](../infra/azure/README.md) (templates +
unverified items).

Legend — **Owner** is a role you must name before starting; **Gate** means the
cutover cannot proceed until it is satisfied.

---

## 0. Before any Azure access exists

| ☐ | Item | Owner | Evidence |
| --- | --- | --- | --- |
| ☐ | Local gate green on the branch to be deployed: `.\scripts\check.ps1` (backend ruff, scripts ruff, backend pytest, frontend typecheck, Vitest, production build) | Dev | Command output attached to the ticket — note that the frontend stages have **not** run in the authoring environment |
| ☐ | `.github/workflows/ci.yml` has executed on GitHub for this commit, including the 19 live MySQL migration tests | Dev | Run URL |
| ☐ | `azure-deploy.yml` actions pinned to full commit SHAs, not tags (ADR-0019 convention) | Dev | Diff; blockers list says the current tags are unverified |
| ☐ | Branch protection + required status checks + `production` environment required reviewers enabled | Repo admin | Screenshot/settings export — the workflow file alone does not enforce anything |
| ☐ | Named humans assigned to every Owner column below | Project lead | This file, updated |
| ☐ | Decision recorded: region, subscription split, resource names, `nameToken`, SKUs, MySQL network mode, backup retention, HA, geo-redundant backup, monitoring yes/no | Architecture owner | Decision record / ADR |

## 1. Provisioning

| ☐ | Item | Owner | Evidence |
| --- | --- | --- | --- |
| ☐ | Resource groups created (staging, production) — not by the template | Ops | `az group show` |
| ☐ | Every `<ANGLE_BRACKET>` placeholder replaced; every `DECIDE:` marker resolved | Ops | Parameter-file diff |
| ☐ | `az bicep build` + `az bicep lint` clean for `main.bicep` and all 7 modules | Dev | Output |
| ☐ | `az deployment group what-if` reviewed line by line | Ops + architecture owner | what-if output attached |
| ☐ | Unverified-items table in `infra/azure/README.md` walked to zero, with template corrections committed | Dev | That table, updated |
| ☐ | GitHub OIDC app registrations + federated credentials exist, subjects exactly `repo:<owner>/<repo>:environment:<env>` | Ops | `az ad app` / portal export |
| ☐ | RBAC: RG `Contributor`, bootstrap-vault `Key Vault Secrets User`, role-assignment path agreed | Ops | `az role assignment list` |
| ☐ | First staging deployment from the parameter file alone succeeds | Ops | Deployment correlation id |
| ☐ | Stack outputs recorded: `backendUrl`, `frontendUrl`, `keyVaultName`, MySQL FQDN/port, MI principal id | Ops | Ticket — values are not secrets, hostnames are fine |

## 2. Secrets and identity — **Gate**

| ☐ | Item | Owner | Evidence |
| --- | --- | --- | --- |
| ☐ | Vault has soft delete + purge protection + RBAC enabled | Ops | `az keyvault show` |
| ☐ | Exactly one vault role assignment: backend MI as *Key Vault Secrets User* | Ops | `az role assignment list --scope <vault>` |
| ☐ | `datadiet-database-url` secret written (runtime user, TLS options proven — section 6.1 of the runbook) | DBA + Ops | `az keyvault secret show` **by name/version only, never `--value`** |
| ☐ | `datadiet-auth-jwt-secret` written: fresh ≥32-char random value, not a dev placeholder, not reused anywhere | Security | Generation is logged; the value is not |
| ☐ | No vault data-plane role is granted to the CI identity — it needs none (the SWA token comes from the site's management plane) | Ops | `az role assignment list --scope <vault>` shows only the backend MI |
| ☐ | No secret value in any committed file, parameter file, workflow, log, or ticket | Security | Secret scan clean |
| ☐ | Key Vault references resolve on the site (application settings show `Resolved`) | Ops | Portal / `az webapp config appsettings list` — confirm the resolved *state*, not the value |
| ☐ | Rotation runbook understood: unversioned references pick up a new secret version within ~24h | Security | Written note |

## 3. Database — **Gate**

| ☐ | Item | Owner | Evidence |
| --- | --- | --- | --- |
| ☐ | `require_secure_transport=ON` and `tls_version` applied as intended | DBA | `az mysql flexible-server parameter show` |
| ☐ | TLS actually used, proven from inside the App Service image (`Ssl_cipher` non-empty) | Dev | Query output — currently **blocker B3** |
| ☐ | Network mode final and immutable-verified; firewall rules pinned to the plan's outbound IPs **or** VNet integration configured | Ops | `az mysql flexible-server ...` + integration list |
| ☐ | Private path (if chosen) resolves from the site: `getaddrinfo(<mysql-fqdn>)` returns the private address | Ops | Output — **blocker B4** |
| ☐ | Migration vs runtime DB users created with the documented grants; runtime user is DML-only | DBA | `SHOW GRANTS` — **blocker B7** |
| ☐ | Backup retention + geo choice match the recorded decision; PITR window confirmed | DBA | Portal/CLI |
| ☐ | Manual pre-migration backup taken and named | DBA | `az mysql flexible-server backup` |
| ☐ | **Restore drill re-executed on Azure** to a scratch server, checksums verified | DBA | New drill record — the existing 21/21 result was local MySQL only and does not transfer |
| ☐ | Character set/collation `utf8mb4` / `utf8mb4_0900_ai_ci` as intended | DBA | Parameter values |

## 4. Migrations — **Gate**

| ☐ | Item | Owner | Evidence |
| --- | --- | --- | --- |
| ☐ | `scripts/migration_preflight.py` run against the real target, read-only | DBA | Full report attached |
| ☐ | Revision list (`0001`…`0012`) reviewed by a named person | Architecture owner | Sign-off |
| ☐ | Approved maintenance window with a human performing `alembic upgrade head` | Ops | Change ticket |
| ☐ | `alembic current` == head after apply | DBA | Output |
| ☐ | Platform-admin re-grants handled per ADR-0017 (explicit, audited, one operator action each) | Security | Audit rows |
| ☐ | No workflow, and no intention to build one, that migrates automatically | Architecture owner | Assertion in the ticket |
| ☐ | Rollback boundary `0005` (ADR-0016) acknowledged; `0012` understood as forward-only evidence (ADR-0020) | DBA | Note |

## 5. Application deployment

| ☐ | Item | Owner | Evidence |
| --- | --- | --- | --- |
| ☐ | Backend package verified to contain `requirements.txt` and `app/main.py` at the root | Dev | Build log / artifact listing |
| ☐ | Oryx built dependencies on deploy (no `ModuleNotFoundError` in the startup log) | Dev | Site log |
| ☐ | `appCommandLine` binds the built-in image's expected port; `--forwarded-allow-ips` not widened to `*` | Dev | `az webapp config show` |
| ☐ | Frontend built with the correct `VITE_API_BASE_URL`; bundle calls the intended API origin | Dev | Network trace from the browser |
| ☐ | Backend `httpsOnly`, `minTlsVersion=1.2`, `ftpsState=FtpsOnly` in the live resource | Ops | Site config JSON |
| ☐ | Health check path `/api/v1/health` configured and keeping instances warm | Ops | Portal |
| ☐ | `DEMO_DATA_ENABLED=false` (unless a recorded decision says otherwise) and `AUTH_DEV_PROVIDER_ENABLED=false` | Security | App settings |
| ☐ | CORS list == the exact frontend origins, HTTPS only, no `*` | Security | `CORS_ORIGINS` value + browser preflight result |

## 6. Functional verification on staging — **Gate**

| ☐ | Check | Expected |
| --- | --- | --- |
| ☐ | `GET /api/v1/health` | 200, `environment` correct |
| ☐ | `GET /api/v1/health/ready` | 200 `ready` (proves DB path end to end) |
| ☐ | `GET /api/v1/auth/config` | 200; `dev_login_enabled: false` in production |
| ☐ | `POST /api/v1/auth/dev-login` | **not 2xx** — fail-closed (503/403), never 401-assumed |
| ☐ | `GET /api/v1/users` unauthenticated | non-2xx |
| ☐ | Signed-in flow with a real identity-provider token | **Blocked by B2** — HS256 only, no RS256/JWKS implemented. Until then this deployment is not a usable production service for real users |
| ☐ | Every UI view loads with empty, error and loading states | Screenshots |
| ☐ | Audit rows appear for a write and a denial (`authorization.denied`) | `audit_events` query |
| ☐ | Out-of-scope institution id returns 404, not 403/500 | Response body |

## 7. Operations readiness

| ☐ | Item | Owner | Evidence |
| --- | --- | --- | --- |
| ☐ | Log access named: who can read App Service logs, who can query MySQL | Ops lead | Documented list |
| ☐ | Monitoring decision is explicit: **the app emits no Application Insights telemetry today**, so either accept log-only operation or schedule the OpenTelemetry work | Architecture owner | Decision record |
| ☐ | Alerts on `/api/v1/health/ready` failure and on instance/CPU saturation | Ops | Alert rule |
| ☐ | Ownership + support contact published in the deployment record | Project lead | Ticket |
| ☐ | Cost review against the category list, priced with the Azure calculator for the actual region/SKUs | Finance + Ops | Quote, not an estimate from this repo |
| ☐ | DNS/custom-domain plan (TXT validation, cert issuance, old hostname disposition) | Network owner | Zone export |
| ☐ | DR expectations stated: no second region, no HA by default, restore = new server | Architecture owner | Accepted-risk note |

## 8. Production approval

| ☐ | Item | Owner |
| --- | --- | --- |
| ☐ | All gates above satisfied **or** an explicit written waiver naming the blocker and the compensating control | Architecture owner |
| ☐ | `docs/production-readiness.md` verdict updated by a human to reflect what is now true | Dev + owner |
| ☐ | B2 (no real IdP) explicitly addressed: production is either knowingly fail-closed (nobody can sign in) or RS256/JWKS is implemented and tested | Security |
| ☐ | GitHub `production` environment approval recorded | Repo admin |
| ☐ | Go/no-go decision and participants logged | Project lead |

## 9. Post-cutover (first 48 hours)

| ☐ | Item |
| --- | --- |
| ☐ | Re-run the [section 6](#6-functional-verification-on-staging--gate) probes against production |
| ☐ | Watch startup logs, `Ssl_cipher`, and error rate; confirm no Key Vault resolution warnings |
| ☐ | Confirm the staging→production promotion is reflected in the frontend URL users actually have |
| ☐ | Verify a real backup completed on the new schedule and note its name |
| ☐ | Commit every correction discovered during the real deployment back into `infra/azure/` — the templates, not only the live resources |
| ☐ | Rotate the MySQL admin password out of the bootstrap vault if it was ever exposed to a shell |
| ☐ | Update the [architecture status](azure-architecture.md#8-implemented--templated--unverified) so "templated" becomes "verified" only where it truly did |

## 10. Abort criteria

Stop and roll back ([runbook section 9](azure-deployment.md#9-rollback-and-recovery)) if:

- readiness stays degraded after secrets and network are believed correct;
- any unauthenticated endpoint returns data that should require a token;
- `dev-login` succeeds in `ENVIRONMENT=production` (a code-level bug — stop the
  cutover and file it, do not "fix" it with configuration);
- a Key Vault reference resolves to a development placeholder secret;
- the database accepts a plaintext connection while `require_secure_transport`
  is expected to be enforced;
- a migration step produced unexpected DDL in review.

Nothing on this list is satisfied by re-running the pipeline. Each is a human
investigation.
