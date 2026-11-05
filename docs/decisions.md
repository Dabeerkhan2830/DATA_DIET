---

## ADR-0010 — Production write guards for governance endpoints

*Status (Phase 7): condition resolved by ADR-0014. The per-endpoint write
guards are retired; every protected route (reads and writes alike) now goes
through the authorization layer, which fails closed in production with 503
`auth_not_configured:` when no signing secret is configured. Identity is
server-verified and no client-supplied field is ever trusted.*

**Decision.** There is no authentication/authorization implementation yet. In `ENVIRONMENT=production`, endpoints that create/update/activate/release governance objects return HTTP 503. The client-supplied `institution_id` (or any other field) is never trusted as proof of identity or access.

Covered endpoints: retention policies, policy versions, policy activation, holds (create/release), asset assessment runs and decisions creation (retention governance writes). Classification runs are also guarded (see ADR-0012). Read-only endpoints and the health/readiness probes remain available.

**Why.** Prevents acting on institutional data or exposing governance operations in an environment where no real user/institution context exists. This honors the safety rules (never claim capability, never bypass approvals) while keeping the system demoable in development/test.

**Consequences.** Deployment to production must first provide a real authN/authZ layer (and identity context) before removing these guards. Operations teams see a clear, machine-readable 503 with an explanation when they attempt writes.

---

## ADR-0011 — Connector provisioning remains out of scope until auth context exists

*Status (Phase 7): the production guard is retired into ADR-0014's fail-closed
auth layer; connector provisioning itself remains out of scope — a verified
identity does not conjure a real institutional integration.*

**Decision.** Connector write endpoints return HTTP 503 in `ENVIRONMENT=production` until a real authenticated user/institution context exists. No connector "provisioning" UI, no automatic scanning, and no file movement are exposed.

**Why.** Connecting to real institutional systems or transmitting metadata requires verified identity, scope enforcement, and an allowlist; inventing a connector would violate "never fabricate an integration".

**Consequences.** `GET /api/v1/connectors/sources` returning an empty list remains honest in Phase 5 (no connectors configured).

---

## ADR-0012 — Classification and data-quality analysis are metadata-only and advisory; runs guarded in production

*Status (Phase 7): the run-endpoint guard is retired into ADR-0014's
fail-closed auth layer; a classification run now requires the admin role's
`classification:write` permission. All metadata-only/advisory properties below
are unchanged.*

**Decision.** Classification is deterministic, explainable, and never reads file contents, never transmits metadata outside the system, never mutates asset fields (category/sensitivity), never selects/executes retention policy, never triggers lifecycle actions (archive/disposal/retrieval/move). 

Key properties:
- Rules are versioned (`RULE_VERSION = "classification-v1"`) in code (not runtime-editable); rule changes ship via code review. 
- `ClassificationResult` is immutable, append-only with `input_fingerprint` (SHA-256 over canonical inputs + rule version) and uniqueness `(asset_id, rule_version, input_fingerprint)` enabling idempotent re-runs. 
- Confidence levels documented (`high/medium/low/none`); conflicts cap confidence and resolve with protective tie-break; "unknown"/insufficient evidence → explicit `unclassified`/`unknown`, never silently low. Extension/filename never proves contents (warnings). 
- Data-quality checks (missing metadata, invalid/unsupported extensions, conflicting values, possible/confirmed duplicates, stale observations, inconsistent source mappings, unclassified) are computed on demand; duplicates are flagged but never merged/deleted. Missing metadata ≠ proof of low sensitivity. 
- Write runs (`POST /api/v1/classification/assets/{asset_id}`) return HTTP 503 in `ENVIRONMENT=production` until a real authenticated user/institution context exists. Reads (rules, latest, history, per-asset quality, paginated findings, checks) are safe for display in dev/test. All classification events are recorded in audit trail. 

**Why.** Meets Phase 5 requirements while preserving all Phase 1-4.1 safety guarantees (advisory-only, synthetic-only development, no content scanning, no external AI, no destructive/automatic operations). 

**Consequences.** Classification history persists across rule changes (each result stores rule version). Frontend shows proposals and findings only; human approval remains in retention assessment/review flows. MySQL migration/integration tests may be skipped when `MIGRATION_TEST_DB_URL` unavailable (documented).

---

## ADR-0013 — Unified review workflow: append-only decisions, optimistic concurrency, and no execution path

**Decision.** Phase 6 unifies the review workflow without adding a second source of truth for decisions or assessments:

- **Reuse, not duplication.** The human decision record stays the existing append-only `retention_decisions` table (`RetentionDecision`). No new decision/assessment-history table is introduced. `"reject"` is added to the `DecisionValue` vocabulary (the column is `String(40)` with no CHECK, so no schema change) and the queue/aggregation reuse the existing assessment, hold, policy, classification, and data-quality services.
- **One decision per assessment, race-safe.** Migration `0007_review_decision_integrity` replaces the non-unique `ix_retention_decisions_assessment_id` index with the unique constraint `uq_retention_decisions_assessment_id`. A concurrent double-submit therefore fails at the database (mapped to HTTP 409) instead of creating a second row. History is never edited or erased.
- **Supersession.** Correcting a decision is an explicit supersession: the asset is re-assessed (a new immutable `RetentionAssessment` row) and the reviewer decides on the new assessment. A decision against an obsolete assessment is refused when the client opts into freshness tokens (below), so approval cannot silently ride an out-of-date assessment.
- **Optimistic concurrency.** The review form submits `expected_assessed_at`, `expected_policy_version_id`, and `expected_holds_active` — the versions and hold count it displayed. The server verifies them and returns **409 `stale_review_conflict`** when the assessment was replaced by a newer one, the applicable policy moved to a new active version, or the active-hold state changed. Stale conflicts are recorded in the audit trail and no decision is written.
- **Hold invariant.** Approving a recommendation for a later workflow (`approve_for_later_workflow`) is refused with **409 `hold_conflict`** while any active hold blocks the asset. Active holds override incompatible lifecycle-advancing recommendations. `retain`, `request_more_information`, and `reject` remain available. Hold state is always recomputed server-side; the client's hold value is never trusted.
- **Rationale enforcement.** Rejection and information requests require a substantive rationale (≥ 10 characters), validated in the request schema and enforced again by the service. The free-text rationale is stored on the decision row and is deliberately **not** copied into the audit payload.
- **Transactional audit.** `audit.record_event(..., commit=False)` lets the decision row and its audit events (`review.decision_created`, plus `review.decision_rejected` / `review.information_requested`) commit in a single transaction; a partial write cannot leave governance history inconsistent.
- **A decision is not an execution command.** Recording any decision — including approval — performs no archive, restore, move, or delete. The unified view states this explicitly (`provenance.file_operations`), and no file-operation endpoint exists.
- **Tenant scope.** Every nested lookup validates the optional `institution_id` against the resource and reports a mismatch as 404 (scope membership is not disclosed). This is validation, not authorization: at the time of ADR-0013 all governance writes returned 503 in `ENVIRONMENT=production` until a real identity context existed (ADR-0010); Phase 7 replaced that historical guard with permission plus institution-scope checks (ADR-0014).
- **Read auditing.** Existing convention does not audit reads; the review-queue and governance-view reads are therefore not audited. State changes (decisions, rejections, information requests, stale/hold conflicts) are.

**Why.** The requirements demand an append-only, tamper-evident review workflow with server-enforced invariants and safe failure. Reusing the Phase 3 decision/assessment subsystem avoids divergent histories, and database-enforced uniqueness plus optimistic-concurrency tokens close the concurrency and staleness gaps without inventing an execution capability the system does not have.

**Consequences.** The review queue exposes a `severity` derived as the categorical maximum of the latest assessment's finding severities (documented vocabulary, not an invented score) and a `review_status` (`open`/`decided`) derived from the decision history. MySQL migration/integration tests for `0007` are skipped when `MIGRATION_TEST_DB_URL` is unavailable (documented). 

---

## ADR-0014 — Identity, authentication, and authorization (Phase 7)

**Decision.** Phase 7 adds server-verified identity and a minimal role/permission model, implemented as the
resource-server half of OIDC with **strict HS256 JWT bearer tokens, stdlib only** (no PyJWT/jose dependency):

- **Token verification.** `app/core/security.py` verifies exactly three base64url segments, the algorithm from a
  module constant (`ALGORITHM = "HS256"`, never from the token header), the signature via `hmac.compare_digest`,
  and the required claims `iss`, `aud`, `exp`, `sub` (`current >= exp` is expired; `nbf` when present).
  Every failure maps to a stable machine-readable prefix (`malformed_token`, `invalid_signature`,
  `token_expired`, `invalid_issuer`, `invalid_audience`, `missing_claims`, `unsupported_algorithm`, …) returned
  as 401 with no token content echoed.
- **No RS256/JWKS on purpose.** Real OIDC federation (RS256 + JWKS discovery) is *not* implemented, so
  production stays fail-closed and no identity provider can be claimed as configured when it is not. An
  operator integration boundary exists (the token contract above) and a deterministic development provider
  (`POST /api/v1/auth/dev-login`) issues real tokens through the same verification path; it is hard-disabled in
  production (`sign_in_unavailable:` 503).
- **Fail closed.** In `ENVIRONMENT=production` with no `AUTH_JWT_SECRET` (or the dev placeholder), every
  protected route — reads and writes alike — returns 503 `auth_not_configured:` at request time
  (`require_auth_configured`). Outside production an empty secret auto-fills with a well-known development
  value. `GET /api/v1/auth/config` (public) reports the honest mode: `development`, `bearer_boundary`, or
  `unconfigured`.
- **Directory is authoritative.** Token claims about institution/role are never used for authorization.
  `_resolve_subject` resolves `email` claim or numeric `sub` against the `app_users` / `user_memberships`
  directory; an unmatched identifier is `unknown_account` (401), an inactive account is refused, and the
  server-derived identity (never client-supplied `reviewer` text) becomes the decision actor.
- **One dependency, every protected route.** `require_permission(PERMISSION_*)` (backed by
  `resolve_institution_scope` / `ensure_institution_access`) is applied uniformly: nested IDs are checked
  against the caller's memberships; an out-of-scope resource is reported as **404** (`out_of_scope` /
  `institution_out_of_scope`), never 403, so existence is not leaked across tenants. Denied **writes** are
  audited as `authorization.denied`; denied/failed reads are not audited (extends ADR-0013).
- **Role matrix (documented, minimal).** `viewer` = `inventory:read`, `governance:read`, `retention:read`,
  `sources:read`; `reviewer` adds `retention:assess`, `review:decide`; `admin` adds `retention:write`,
  `sources:write`, `assets:write`, `classification:write`; `users:manage` and cross-institution scope require
  `is_platform_admin`. Multiple memberships without an explicit `institution_id` on a scoped list endpoint
  return **422** (`institution_id is required`) rather than silently guessing.
- **Session shape.** Bearer tokens are stateless: sign-out is client-side discard; there is no logout
  endpoint and no cookie/CSRF surface. The frontend stores the token in `localStorage` under
  `datadiet.access_token` (the user's own credential, verified server-side on every request) and renders
  permission-aware navigation/actions as usability only — the backend re-checks everything.
- **User management.** `GET/POST/PATCH /api/v1/users` and membership endpoints require `users:manage`;
  every account or membership change is audited in the same transaction (`users.*`).
  `scripts/bootstrap_admin.py` creates the first platform administrator offline (no HTTP bootstrap in
  production).

**Why.** Phase 7 must retire the production 503 write guards only behind *trusted* authN/authZ. HS256 with a
server-held secret is the smallest verifiable credential system implementable with the existing stdlib-only
dependency set; keeping RS256/JWKS out of scope avoids half-built federation that could be mistaken for a
working IdP integration. Deriving authorization exclusively from the local directory (not token claims)
prevents privilege carried in an issued-but-revoked claim.

**Consequences.** Production endpoints remain 503 until an operator sets a real `AUTH_JWT_SECRET`; when a
real IdP is procured, RS256/JWKS support must be added and tested before claiming OIDC compatibility. The
development provider and paste-a-token sign-in are honest about what they are. Frontend tests inject synthetic
identities via `AuthProvider initialUser`; no real credentials exist anywhere in the repository.

---

## ADR-0015 — Decision supersession: corrections are new decisions, never edits

**Decision.** A wrong human decision is corrected by an explicit supersession, not by editing or deleting
history:

- **Model.** `retention_decisions` gains `supersedes_decision_id` (self-FK, `ON DELETE RESTRICT`) with a
  unique index `uq_retention_decisions_supersedes`, so a decision can replace at most one predecessor and a
  predecessor can be replaced at most once. There is no `superseded_by` column; the replacement is derived by
  join when serializing (`is_superseded`, `superseded_by_decision_id` on the API schema).
- **Validation order (service layer).** institution scope → same asset lineage → no self-reference →
  predecessor must be on a **strictly earlier** assessment of that asset → predecessor not already superseded
  → no cycle (`SUPERSESSION_CHAIN_LIMIT = 200`, defence-in-depth for databases that lost the unique index).
  Failures map to 404 (`supersession_not_found`, `supersession_out_of_scope`) or 409 (`wrong_lineage`,
  `self_reference`, `already_superseded`, `cycle`, `concurrent`).
- **Effective decision.** The governing decision is the head of the supersession chain — the newest decision
  that is not itself superseded (`retention_service.effective_decision_id`), exposed on the governance view
  as `effective_decision_id` and rendered as an "Effective" badge. Superseded decisions stay fully visible in
  history with "Superseded by #N" / "Corrects #N" links.
- **Corrections are fresh assessments.** A superseding decision is always recorded against a *new* assessment
  (the reviewer re-examines current state); the candidates endpoint
  `GET /retention/decisions/supersession/source?assessment_id=` returns the server-computed eligible
  predecessors so the UI can only offer real, already-authorized targets. A substantive rationale (≥ 10
  characters) is required for any supersession, exactly as for rejection.
- **Concurrency.** `IntegrityError` at flush or commit (two reviewers superseding the same decision at once,
  or a second successor racing the unique index) maps to 409 mentioning "concurrent"; nothing is written.
- **Audit.** `review.decision_superseded` and `review.decision_created` are recorded in the same transaction
  as the rows; the free-text reason stays off the audit payload (`reason_length` only). No silent edits or
  deletes exist anywhere in the path — there is no UPDATE or DELETE route for decisions at all.

**Why.** "Preserve the original decision" is a hard requirement, and a self-referencing link is the smallest
schema change that expresses correction without inventing a second history table or a mutable flag. The
unique successor index makes the dangerous states (double replacement) impossible at the database level.

**Consequences.** Migration `0009_decision_supersession` adds the column and index. Cycle prevention is
mostly enforced by the unique index; the service-level chain limit guards degraded databases and bounds
reads. Frontend review history shows superseded/effective markers, and the decision form only opens on the
latest undecided assessment.

---

## ADR-0016 — MySQL migration 0010: forward repair, supported rollback boundary at 0005

**Decision.** Phase 7's investigation of the migration-0005 downgrade defect found three index-before-FK
inversions (`classification_results`, `retention_decisions`, `retention_assessments`). The fix is:

- **Forward repair only, one table.** Migration `0010_classification_downgrade_safety` repairs
  `classification_results` (`classification_results_ibfk_1/_2`: drop the FKs first, then their indexes on
  downgrade; restore only the missing constraints on upgrade, discovered via `information_schema`, so the
  step is idempotent and doubles as the documented repair procedure: `alembic downgrade <one step>` then
  `alembic upgrade head`). `retention_decisions` is deliberately **not** repaired: doing so would strip FKs
  on the supported path (leaving the 0005 schema incomplete) and still could not carry a rollback below 0005
  because `retention_assessments` is unrepairable behind it.
- **Supported rollback boundary = `0005_source_connectors`.** Downgrades to 0005 round-trip cleanly.
  Below the boundary the failure is now *safe*: 0005's downgrade completes, then 0004's first statement
  (`drop_index ix_retention_decisions_institution`) is refused with errno 1553 (index is FK-backed) before
  anything is destroyed, leaving a consistent 0004 state (stamp `0004_review_decisions`) that
  `alembic upgrade head` fully repairs. This behaviour is tested; below-boundary rollback is documented as
  unsupported rather than silently corrupting.
- **Applied history is not rewritten.** Migrations 0001–0009 are untouched; 0008's downgrade gained an
  `ALTER COLUMN role DROP DEFAULT` fix only because 0008 was still uncommitted Phase 7 work at the time.
- **Tested on disposable MySQL.** The suite (`tests/test_migrations_mysql.py`, run when
  `MIGRATION_TEST_DB_URL` is set) covers: head upgrade, FK restrict, nullability, boundary round trip,
  below-boundary safe failure + repair, one-step downgrade, Phase 7 schema, the 0010 repair procedure,
  parametrized partial-rollback gaps at 0009 and 0006, and Phases 4–6 schemas — 14 tests, zero xfails
  against MySQL 8.0.

**Why.** Rewriting applied migrations to tidy the rollback story is explicitly out of scope and risky for
deployed databases; a forward corrective migration plus an enforced, tested boundary gives operators a
predictable recovery path and an honest statement of what is unsupported.

**Consequences.** Operators must not `alembic downgrade` below 0005; the failure mode and the repair
procedure (`upgrade head` from the consistent 0004 state) are documented here and in the migration module.
The parametrized gap tests pin the exact schema remaining after an unsupported partial rollback so any
future change is visible immediately.

---

## ADR-0017 — Revoke the unsafe platform-admin default from Phase 7 migration 0008

**Decision.** Migration `0008_identity_and_authorization` added `app_users.is_platform_admin` with a server default of `TRUE`. This grants platform-wide privileges to pre-existing accounts during the migration and to inserts that omit the field. An institution-scoped `admin` role must not imply platform administration.

Migration `0011_platform_admin_default_false` corrects this without rewriting applied migration history:
- Change the database default to `FALSE`.
- Revoke the platform-admin flag from all existing accounts because the database cannot distinguish an intentional grant from one inherited from the unsafe default.
- Keep the downgrade security-monotonic: it does not restore the unsafe default or privileges.
- Require a trusted database operator to explicitly re-grant platform administration to individually verified accounts after migration.

**Why.** This is a privilege-escalation risk, not a cosmetic default mismatch. Failing closed is preferable to preserving potentially accidental global privileges.

**Consequences.** After upgrading to `0011_platform_admin_default_false`, verify that no unintended platform administrators remain. Any intended platform administrator must be re-granted through a controlled operational procedure. The migration's data correction is intentionally not reversed by downgrade; restoring the old `TRUE` default would recreate the vulnerability. Live MySQL integration tests must verify existing-account revocation and the default for future inserts.

---

## ADR-0018 — Migration preflight is read-only; backups and re-grants are human gates

**Decision.** Add `scripts/migration_preflight.py`, a read-only operator command that reports the configured environment, a credential-free database target, the stamped Alembic revision, the repository head and the pending revisions. It classifies failures with distinct exit codes (2 unreachable, 3 not under Alembic control or ambiguous version table, 4 unknown/off-chain revision, 5 multiple heads) and never applies or writes anything. The migration runbook (`docs/setup.md` §8) requires a test-restored backup and a documented administrator recovery plan before `upgrade head`. Recovery uses the existing offline `scripts/bootstrap_admin.py`, one named account at a time, audited in the same transaction; no HTTP grant endpoint is added.

**Why.** `0011` resets every platform-admin flag, so applying it "and seeing what happens" is unacceptable. `alembic current` reports a revision but not the target or environment, and a hand-typed masking snippet would be untested and easy to get wrong. A small, tested command covers the machine-checkable preflight criteria without new dependencies, while the authorization-critical decisions stay with an operator.

**Consequences.** Existing-database migrations follow a documented procedure. Operators must treat non-zero preflight exit codes as stop signals. The preflight is not wired into `alembic upgrade` and cannot prove a backup exists; it complements, and does not replace, change control. Downgrades remain security-monotonic at `0011` and unsupported below `0005` (ADR-0017, ADR-0016).

---

## ADR-0019 — CI runs on Linux GitHub Actions; the Windows PowerShell gate remains local

**Decision.** Add `.github/workflows/ci.yml`, triggered on every pull request and every push to `main`. It is configured to run on a GitHub-hosted Ubuntu runner with pinned Python 3.14.1 and Node.js 24.13.1, installs `backend/requirements-dev.txt` and the frontend `package-lock.json` (`npm ci`), and runs backend Ruff, operator-script Ruff, backend pytest, the 19-test live MySQL migration suite against an ephemeral `mysql:8.4` service, frontend type checking, Vitest, and the production build. The MySQL step requires `MIGRATION_TEST_DB_URL`, sets `MIGRATION_TEST_ALLOW_DROP=1` only for that step, and asserts that 19 tests pass (not skipped). GitHub Actions are pinned to full commit SHAs with release comments, and the MySQL image is pinned to a verified multi-arch digest. No repository secret or production credential is used, and the job stops at the first failing step.

Extend `scripts/check.ps1` with the same operator-script Ruff invocation (`ruff check ..\scripts` from `backend/`) so the local Windows PowerShell 5.1 gate and CI cover the same operator code. The existing explicit `$LASTEXITCODE` assertions and fail-fast order remain; Ruff's formatter is deliberately not run.

The local gate stays the canonical developer workflow on Windows. CI does not invoke `check.ps1` because the script uses Windows virtual-environment paths; it runs the equivalent commands on Linux. The Windows-only symlink test is expected to execute rather than skip on the Linux runner.

**Why.** The repository had no automated pull-request validation, so correctness depended on a developer remembering to run the local script. The migration suite is the core safety check for `0011` and `0012`, and GitHub's service containers provide a disposable MySQL on Linux without adding a durable test database. Running the same Ruff configuration over `scripts/` closes a gap where operator code was only linted by hand. A single Linux job avoids duplicated test logic and unnecessary services, while the Windows gate remains available for the environment the project is developed in.

**Consequences.** Required status checks and branch protection are repository settings that must be enabled separately; the workflow file alone does not block a merge. Python dependencies are still range-pinned with no lockfile (a lockfile was not added because it could not be validly generated and tested across the supported platforms in this environment), and dependency/secret scanning is not configured; these remain supply-chain gaps (`docs/production-readiness.md`). The workflow has not yet executed on GitHub until a commit is pushed or a pull request is opened. CI validates code, not a deployment: it does not run migrations against a durable database, provision a real identity provider, or prove production configuration.

---

## ADR-0020 — Migration `0012` records the `0011` reset; it does not reconstruct identity

**Decision.** Add forward migration `0012_audit_platform_admin_reset`, which appends one `audit_events` row (`users.platform_admin_reset_recorded`) after `0011` has run. The payload records the reset revision, the post-reset platform-administrator count, and the fact that the operator must preserve a pre-migration export in the change ticket. `0012` changes no account or privilege; the insert is idempotent by event type/entity id, and `downgrade()` is a no-op so the append-only audit row is never deleted.

**Why.** Reverting `0011` or editing its historical behavior would either recreate the accidental privilege grant or leave already-migrated databases without the record. A forward-only migration is safe for both fresh and existing databases, provided it does not pretend to know which identities were revoked. The pre-migration export is the human-owned evidence of the prior grant list; `0012` is durable evidence that the reset revision ran and the post-reset state was observed. Re-granting remains a separate, explicitly audited `bootstrap_admin.py` action.

**Consequences.** Existing databases at `0011` receive the audit row on the next upgrade; databases already at `0012` do not duplicate it. A database where administrators were deliberately re-granted before `0012` records a nonzero post-reset count, which is accurate and must be reconciled with the ticket. `0012` cannot repair a missing pre-migration export and must not be presented as doing so. Live MySQL tests verify the event, the no-privilege-change property, and idempotency across downgrade/re-upgrade.
