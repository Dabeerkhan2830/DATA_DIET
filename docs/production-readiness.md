# Production readiness review (Phase 9)

**Review basis:** the working tree at commit `bc0c4e3` plus the uncommitted
Phase 8/9 changes and the 2026-10-21 remediation. No deployment was performed.

**Verdict: not production-ready.** DataDiet is a tested development/test system
with fail-closed authentication. The controls below do not exist yet, are
development placeholders, or have not been exercised outside a disposable
environment. Nothing in this document claims that a production deployment,
identity provider, secret manager, TLS terminator, production database, or
production backup has been configured or verified.

## What is actually tested

- Local gate: `scripts/check.ps1` exits 0 with 216 backend tests passed and
  20 skipped (19 live-MySQL tests and one Windows-only symlink test), 80
  frontend tests passed, Ruff clean, TypeScript clean, and a production build.
  Operator scripts are linted with the backend Ruff configuration.
- Live migration suite: 19/19 passed against a disposable MySQL 8.0.46
  instance on 2026-10-21, including the `0011` preflight/reset and the new
  `0012` audit-record/idempotency test.
- CI workflow: `.github/workflows/ci.yml` is configured for pull requests and
  pushes to `main`. Its YAML parses and its local equivalents ran, but the
  workflow has **not run on GitHub yet** (nothing in this phase was committed
  or pushed). Docker is not installed in the development environment, so the
  `mysql:8.4` service path was not executed locally; the 19-test migration
  suite passed on MySQL 8.0.46 instead.
- Backup/restore: a real dump-and-restore drill was performed on a disposable
  MySQL instance; 21/21 table checksums matched, the restored revision was
  `0011` at drill time (current head is `0012`), and the preflight exited 0
  (`docs/backup-restore.md` section 9). The separately documented read-only
  backup and least-privilege scratch credentials were not exercised; no
  production-sized, managed-provider, or live restore was tested.
- No migration was applied to a durable database in this phase. The only
  durable databases in the development environment were left untouched.

## Summary of production gates

| Area | Current state | Gate to production |
| --- | --- | --- |
| Identity provider | HS256 shared secret only; no OIDC discovery, RS256/ES256 or JWKS | **Blocker** |
| Secrets | `.env`/process environment only; no manager or rotation procedure | **Blocker** |
| CORS / trusted hosts | CORS allowlist exists; no `TrustedHostMiddleware` or host allowlist | Required |
| TLS / reverse proxy | Nginx placeholder on port 80; no TLS/HSTS/CSP; backend proxied over HTTP | **Blocker** |
| Database privilege/network | Development root and app credentials; port 3306 published; one URL for app and migrations; no TLS | **Blocker** |
| Audit / sensitive data | Append-only application audit events; no retention, centralization, tamper evidence, or alerting | Required |
| Backup / recovery | Documented and drill-tested procedure; manual, with no automation, PITR, or monitoring | **Blocker** for operations |
| Monitoring | Liveness and readiness probes only; no metrics, tracing, or alerting | **Blocker** for operations |
| Migration / admin recovery | Read-only preflight (MySQL-only), documented `0011`/`0012` runbook, offline one-account recovery with actor and explicit reactivation/role-change flags; manual by design | Procedure ready; production rehearsal and pre-migration export audit not done |
| CI / supply chain | Workflow added with Actions pinned to full SHAs and a pinned MySQL image; branch protection, dependency/secret scanning, and Python lockfile not in place; workflow has not run remotely | Required |
| Browser boundary | Bearer token in `localStorage`; no CSP; API docs exposed through the proxy | Required |

## 1. Identity: OIDC, RS256, and JWKS

**Current state.** `backend/app/core/security.py` verifies HS256 bearer tokens
using only the standard library: exactly three base64url segments, an exact
`alg` check (no token-selected algorithm), constant-time HMAC comparison, and
required issuer, audience, and expiry claims. `backend/app/core/auth.py`
resolves the verified identity against the local `app_users` /
`user_memberships` directory; token claims never grant institution or role
access. Missing/invalid/expired tokens return 401, missing permissions 403, and
out-of-scope resources 404. Denied writes — permission failures and write
scope failures — are audited with `authorization.denied`; scope-denial payloads
omit the target institution id so the audit trail does not reveal resource
existence. Production `/auth/dev-login` refusal is decided before any database
write, so an attacker cannot create a denial audit row.

Production fails closed: `config.py` strips the well-known development secret
and hard-disables the development sign-in provider when
`ENVIRONMENT=production`; a configured secret shorter than 32 characters
refuses startup; an absent secret leaves protected endpoints at 503
`auth_not_configured:`. Configuration validation errors hide submitted input.

**Gap.** This is not a real OIDC integration. There is no RS256/ES256
verification, no JWKS discovery/fetch/cache, no `kid` rotation handling, no
OIDC provider metadata, no refresh or revocation flow, and no production
sign-in path. An operator can paste an externally issued HS256 token, but a
real identity provider normally signs with an asymmetric key and publishes a
JWKS document. The current shared-secret model means every token issuer and
verifier holds the same secret, and rotating it invalidates all sessions.

**Required before production.**

- Record an ADR for the identity architecture, including the resource-server
  versus browser-flow boundary and the allowed signing algorithms.
- Implement OIDC discovery and RS256/ES256 JWKS verification with a vetted
  library (this adds a dependency) or an explicitly reviewed implementation;
  enforce issuer, audience, token type, expiry, and clock skew; support key
  rotation by `kid`.
- Keep authorization directory-based. Define how a verified subject/email maps
  to a local account and what happens when no account exists (deny; no
  auto-provisioning by default).
- Decide whether refresh tokens, session revocation, or a backend-for-frontend
  (BFF) with HttpOnly cookies are required. The current stateless bearer token
  has no logout/revocation endpoint; sign-out is client-side only.
- Add tests using generated keys and a local JWKS document: valid token
  accepted; wrong key, algorithm, issuer, audience, expiry, and malformed token
  rejected; key rotation accepted; dev-login and the shared secret are
  unavailable in production.

**Exit criteria.** A staging deployment authenticates a real user through an
approved provider; all negative cases above are covered by automated tests;
production has no shared HS256 secret and no development sign-in path.

## 2. Secret management and rotation

**Current state.** Configuration comes from environment variables and an
optional git-ignored `.env` (`backend/app/core/config.py`). `.env.example`
documents the variables. The development database URL contains well-known
development credentials (`DEV_DATABASE_URL`), and the development compose file
uses throwaway root/app passwords. The JWT secret is a single environment
value; there is no key ID or overlapping-key rotation.

**Gap.** There is no secret manager, no least-privilege injection, no rotation
runbook, and no production check that rejects the well-known development
database URL. A production process started with `ENVIRONMENT=production` and
an accidentally copied `.env` could connect to a development database. The
fail-closed and dev-provider protections above depend on `ENVIRONMENT=production`
being set correctly; a mislabelled environment retains the development secret
and sign-in provider. Secrets may be visible in process environments and are
not audited. There is no secret-scanning configuration in the repository.

**Required before production.**

- Inject secrets at runtime from an approved secret manager; never bake them
  into images, frontend bundles, workflow files, or logs.
- Refuse to start (or fail readiness) in production when `DATABASE_URL` is the
  development default or another known placeholder; validate TLS settings.
- Separate development, staging, and production credentials and environments.
- Write and rehearse a rotation procedure for the database credentials and the
  token-signing keys, including overlap, rollout, revocation, and rollback.
- Enable secret scanning and dependency/security updates (see section 9).
- Document that rotating the HS256 secret invalidates every current session;
  with a JWKS design, define the key-overlap window instead.

**Exit criteria.** No long-lived secret is stored in the repository or an
image; production configuration is injected and validated at startup; a
rotation has been rehearsed without downtime or leaked credentials.

## 3. CORS, trusted hosts, and the browser boundary

**Current state.** `CORSMiddleware` is configured with `settings.cors_origins`
(default `http://localhost:5173`, configurable as a comma-separated list). There
is no `TrustedHostMiddleware` and no host allowlist. The frontend stores the
bearer token in `localStorage` (`frontend/src/api/tokenStore.ts`); sign-out
removes it. The Nginx placeholder sets `X-Content-Type-Options`,
`X-Frame-Options`, and `Referrer-Policy`, but no Content-Security-Policy,
HSTS, or Permissions-Policy, and it proxies `/docs` and `/openapi.json`.

**Gap.** CORS is not a substitute for host validation, and `localStorage`
tokens are readable by any script that achieves XSS. There is no CSP to reduce
that blast radius, no documented decision about API documentation exposure, and
no rate limiting at the application or edge.

**Required before production.**

- Set an explicit HTTPS-only CORS allowlist; never use `*` with credentials.
- Add and test `TrustedHostMiddleware` with the production hostnames, and
  configure the reverse proxy with an explicit `server_name` rather than `_`.
- Disable `/docs`, `/redoc`, and `/openapi.json` in production, or protect them
  behind the same identity/authorization boundary and document who may use
  them.
- Add a CSP, HSTS, Permissions-Policy, and a reviewed header set at the edge.
  Ensure a compatible CSP with the Vite bundle before enforcing it.
- Decide whether the SPA keeps bearer tokens in `localStorage` or moves to a
  BFF/HttpOnly-cookie design. If it keeps `localStorage`, document the residual
  XSS risk and enforce dependency hygiene and CSP.
- Add rate limits for authentication and write endpoints at the edge; verify
  they return 429 without leaking whether an account exists.

**Exit criteria.** Requests with an unapproved `Host` or `Origin` are rejected;
the production bundle passes a CSP smoke test; documentation endpoints are not
public; an XSS review has accepted or removed the `localStorage` exposure.

## 4. TLS and reverse-proxy trust

**Current state.** `infra/nginx/nginx.conf` is explicitly a future deployment
placeholder. It listens on port 80, uses `server_name _`, proxies API requests
to `host.docker.internal:8000` over HTTP, and forwards `Host`,
`X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto`. The compose `edge`
profile publishes port 8080. The documented uvicorn command does not configure
proxy-header trust explicitly, so client-IP and scheme handling depend on the
runtime defaults and the deployment topology.

**Gap.** There is no TLS termination, certificate management, HTTP-to-HTTPS
redirect, HSTS, or documented trust boundary for forwarded headers. A backend
reachable directly could be talked to over plain HTTP and could accept spoofed
forwarded headers. The Nginx image is a development placeholder, not a
hardened production configuration.

**Required before production.**

- Terminate TLS at a managed load balancer or a hardened reverse proxy with
  managed certificates; redirect port 80 to 443 and enable HSTS after the
  HTTPS redirect is verified.
- Keep the application backend on a private network; expose only the proxy.
- Configure uvicorn/FastAPI proxy-header handling explicitly and restrict
  `forwarded-allow-ips` to the known proxy addresses. Do not trust
  client-supplied forwarding headers.
- Add request size, header size, and timeout limits; set sane keepalive and
  upstream timeouts; add rate limiting (section 3).
- Pin and patch the proxy image; do not expose the development compose file as
  a production deployment.

**Exit criteria.** External scans show only 443 (plus the approved redirect);
the backend is unreachable from untrusted networks; spoofed forwarding headers
do not change the client identity or scheme seen by the application.

## 5. Database least privilege and network exposure

**Current state.** The development compose file publishes MySQL on
`0.0.0.0:3306`, creates a root account and a `datadiet` application account
with development passwords, and uses one `DATABASE_URL` for both the
application and Alembic. There is no database TLS configuration, no separate
migration or backup role, and no connection-pool limit beyond the SQLAlchemy
defaults in `backend/app/db/session.py` (`pool_pre_ping`, `pool_recycle=1800`).
The application does not apply migrations at startup; operators run Alembic
manually.

**Gap.** A production database must not be publicly reachable, must require
TLS, and must not give the runtime application DDL rights. Sharing one
credential between the application, migrations, and backups makes least
privilege impossible and increases the blast radius of a stolen credential.

**Required before production.**

- Put MySQL on a private network/security group with no public ingress; allow
  only the application, migration, and backup paths.
- Require TLS (`ssl-mode=VERIFY_IDENTITY`) and verify the server certificate.
- Provision separate roles: application DML only (no DDL, no `GRANT`), a
  migration role with schema-change rights used only during a controlled
  window, and a read-only backup role.
- Rotate credentials, remove the development root account from use, and audit
  role membership.
- Set connection and query timeouts, pool limits, and a maximum connection
  count appropriate to the deployment; monitor saturation.
- Back up through the procedure in `docs/backup-restore.md`, using the
  dedicated backup role.

**Exit criteria.** The application credential cannot run DDL or read unrelated
databases; the database rejects non-TLS connections; the network path is
private; a credential-rotation drill succeeds.

## 6. Audit logging and sensitive-data handling

**Current state.** `audit_events` records actor, event type, entity type/id,
JSON payload, and timestamp. Authorization denials are audited; platform-admin
bootstrap events are recorded in the same transaction as the change. The table
is append-only by application convention, not by a database constraint or
trigger. There is no structured logging configuration, log aggregation/SIEM,
retention policy, tamper-evident storage, or alerting. Application data is
metadata-only by design and does not include file contents, but it does include
account emails, institution data, and audit payloads. Development uses
synthetic data only.

**Gap.** "Audited" currently means a row in the application database, readable
by the same database credential. There is no independent retention, access
control, or alerting for privileged actions. Logs are not centralized, and
there is no documented data-classification or PII-retention policy for the
audit payloads.

**Required before production.**

- Define and document audit retention, access control, and tamper resistance;
  consider shipping audit events to an append-only external store/SIEM.
- Add structured application logs with correlation IDs, redaction of tokens and
  credentials, and a central destination with access control.
- Alert on authentication failures, authorization denials, platform-admin
  grants, migration/preflight failures, backup failures, and readiness
  failures.
- Define what metadata is permitted in audit payloads; never log bearer
  tokens, passwords, connection strings, or file contents. Test redaction.
- Classify the user directory and audit data as confidential and include them
  in the institution's retention and access-review process.

**Exit criteria.** A privileged action produces an audit event in an
independent, access-controlled store within the agreed interval; retention and
redaction are tested; an alert is demonstrated for a failed privileged action.

## 7. Backup, recovery, and operational monitoring

**Current state.** `docs/backup-restore.md` documents target confirmation,
credential-safe invocation, timestamps, integrity checks, scratch restores,
revision verification, retention, approval, and troubleshooting. A disposable
MySQL 8.0.46 drill restored 21/21 tables with matching checksums and revision
`0011` (current head `0012`); the scratch database and dump were removed
afterward. Section 2 now separates the read-only backup identity from the
scratch-only restore identity and sections 5–6 require exact target
confirmation and restore approval, but those account grants and the secure
password prompt were not exercised by the drill. There is no scheduled backup,
automatic verification, point-in-time recovery, or backup monitoring in the
repository. Monitoring consists of `/api/v1/health`
(liveness) and `/api/v1/health/ready` (database readiness) only; there are no
metrics, traces, dashboards, or alerts.

**Required before production.**

- Agree RPO/RTO with the institution, then implement scheduled encrypted
  backups and (if needed) point-in-time recovery through the managed provider.
- Automate backup-success and backup-age checks; alert on failure and on a
  missed schedule. Keep the restore drill manual and documented, or automate
  it with the same safety checks.
- Add metrics/tracing (request rate, latency, errors, database saturation,
  readiness), dashboards, and alert routing with an on-call owner.
- Write incident runbooks for database loss, failed restore, disk exhaustion,
  certificate expiry, identity-provider outage, and a compromised credential.
- Schedule regular restore drills (at least quarterly and after schema
  changes) and retain the evidence.

**Exit criteria.** A backup failure alerts before the RPO is breached; a
restore drill on staging succeeds under the documented procedure; monitoring
covers the application, database, proxy, and backup path.

## 8. Migration and platform-admin recovery

**Current state.** Migration `0011_platform_admin_default_false` is reviewed
and tested: it sets the server default to false and revokes existing
platform-admin flags; the downgrade is intentionally security-monotonic.
Forward migration `0012_audit_platform_admin_reset` appends an idempotent audit
event recording the post-reset administrator count; it changes no privilege and
does not reconstruct revoked identities (ADR-0020). `scripts/migration_preflight.py`
is read-only and reports a masked target, revision classification, and pending
revisions with distinct exit codes; it rejects non-MySQL dialects with exit 6.
`docs/setup.md` section 8 documents the maintenance-window procedure, mandatory
pre-migration administrator export, backup gate, verification, administrator
re-grant, and rollback caveats. Recovery uses the offline
`scripts/bootstrap_admin.py` for one named account at a time, with a required
meaningful actor, explicit `--reactivate-user`/`--reactivate-membership` and
`--allow-role-change` flags, and audited previous/resulting state in the same
transaction; there is no HTTP grant endpoint. Scope-denied writes are also
audited (section 1). The supported rollback boundary is `0005_source_connectors`
(ADR-0016).

**Gap.** The procedure is manual and process-enforced. It has not been
rehearsed against a production-like staging database, and the preflight cannot
prove that a backup exists, that the pre-migration administrator export was
preserved, or that the operator's re-grant list is correct. There is no
two-person control in code, and the application does not automatically block a
migration that skips the preflight. The separate backup/restore identities in
`docs/backup-restore.md` have not been provisioned or tested against a real
database.

**Required before production.**

- Use change control: ticket, approver, maintenance window, quiesced writers,
  verified backup, preserved pre-migration administrator export, documented
  re-grant list, and a rollback decision.
- Rehearse the full sequence on production-like staging, including a failed
  DDL retry and a post-restore re-grant.
- Verify the zero-platform-admin state after `0011`, then review the `0012`
  audit event, audit actor/previous/resulting state, and the exported pre-reset
  list before re-granting anyone.
- Require the operator to name a meaningful actor and pass the explicit
  reactivation/role-change flags only after verifying the person and the reason
  for any suspension.
- Keep the preflight and runbook in sync with any new migration; do not add
  automatic migration execution at startup as a shortcut.

**Exit criteria.** A staging rehearsal produces the expected revision, zero
unintended platform admins, the verified re-grant list, an exported pre-reset
list, and an audit trail; an operator can explain every step without
improvising.

## 9. CI, supply chain, and application hardening

**Current state.** `.github/workflows/ci.yml` runs on pull requests and pushes
to `main`: pinned Python 3.14.1 and Node 24.13.1, backend and operator-script
Ruff, backend tests, an ephemeral `mysql:8.4` service for the 19-test migration
suite, frontend typecheck/tests/build, and no repository secrets. The workflow
requires `MIGRATION_TEST_DB_URL`, sets `MIGRATION_TEST_ALLOW_DROP=1` only for
the guarded fixture, and asserts that 19 tests pass rather than skip. Actions
are pinned to full commit SHAs with release comments, and the MySQL image is
pinned to a verified multi-arch digest. The local `scripts/check.ps1` gate
remains the Windows PowerShell 5.1 path.

Remaining gaps:

- The workflow has not executed on GitHub. Required status checks and branch
  protection are repository settings, not code, and are not configured here.
- Python dependencies are range-pinned (`>=`) with no lockfile; CI resolves
  versions afresh. The frontend uses `package-lock.json` with `npm ci`.
- `npm ci` was validated locally, but the locked dev toolchain currently
  reports 3 advisories (1 moderate, 2 critical) in `vitest`,
  `@vitest/mocker`, and `tinypool`; the offered fix is a breaking upgrade to
  Vitest 5. `npm audit --omit=dev` reports 0 production-dependency
  vulnerabilities. Treat the upgrade as a reviewed change; do not run
  `npm audit fix --force` unreviewed.
- No dependency-update automation, secret scanning, SBOM, image signing, or
  container/deployment pipeline is configured in the repository.
- `/docs` and `/openapi.json` are exposed through the placeholder proxy.
- Demo endpoints default to enabled (`DEMO_DATA_ENABLED=true`); production
  should set it false unless a documented decision requires otherwise.
- There is no rate limiting at the application or edge.

**Required before production.**

- Make the CI workflow required on `main`; verify it runs green remotely.
- Pin GitHub Actions to reviewed commit SHAs, enable Dependabot/security
  updates and secret scanning, and add a Python lockfile with hash verification.
- Build a minimal production image or deployment artifact, scan it, sign it,
  and produce an SBOM; keep the development compose file out of production.
- Decide and enforce API documentation exposure and `DEMO_DATA_ENABLED` in
  production.
- Add edge rate limiting and test it.

## 10. Ordered gate to production

This is a sequence, not a risk score:

1. Approve the identity ADR and implement RS256/JWKS verification with a real
   staging provider; keep fail-closed behavior and add negative tests.
2. Introduce a secret manager, production configuration validation, and a
   rehearsed rotation procedure.
3. Configure TLS, reverse-proxy trust, trusted hosts, HTTPS-only CORS, CSP, and
   documentation/rate-limit policy.
4. Provision private networking, database TLS, and separate application,
   migration, and backup roles.
5. Implement audit retention/SIEM, structured logs, monitoring, and alerts.
6. Automate encrypted backups, verify them, and agree RPO/RTO; schedule restore
   drills.
7. Rehearse migrations `0011` and `0012` plus administrator recovery on
   production-like staging, including the pre-migration export and `0012`
   audit record.
8. Make CI green and required, complete a reproducible Python lockfile and
   dependency/secret scanning, and add the production image/deployment
   artifact.
9. Obtain an independent security review or penetration test; then authorize a
   deployment as a separate change.

## Explicit non-claims

- No production deployment, production connection, or durable-database
  migration was performed in Phase 9.
- No real OIDC/IdP, RS256/JWKS verification, secret manager, TLS terminator,
  monitoring stack, or automated backup exists in this repository.
- The CI workflow has not yet been executed by GitHub.
- The restore drill was on a disposable database only; it does not verify a
  production backup, provider snapshot, or point-in-time recovery, and it did
  not exercise the separate read-only backup and scratch restore identities.
- Local tests passing is not production verification. The application must
  remain unavailable to real institutional data until the gates above are
  implemented, reviewed, and tested.
