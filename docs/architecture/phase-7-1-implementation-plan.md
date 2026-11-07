# DataDiet — Phase 7.1 Implementation Plan

| | |
| --- | --- |
| Status | **Plan, revised — awaiting approval.** No application code, migration, dependency, configuration, test or deployment file has been changed by this document. |
| Derived from | [archive-evidence-architecture.md](./archive-evidence-architecture.md) as approved-and-refined in Phase 7.0 (including the D-12 integrity-release refinement) |
| Revision pass | 2026-11-06, after the plan review. P-6 was **not approved** and is redesigned here (MySQL single-flight: P3.2, P5.2, P6, P7, P16, P17, P18, P-6′); the content-hash ordering is corrected (P2.1, P3.2, P6, P7, P11, P16 — `ContentHandle` loses its `sha256`, ingestion becomes three passes with a between-pass fingerprint check); the ADR-acceptance rule is rewritten (P2.2, P19's P-7′, P20, per revised §14.1); and the status wording plus the two permission/section-reference defects are fixed (P2.2, P4, and §1.3/§3.9/§7.2a on the architecture side). Architecture side of the same pass: §16.17 there. **Still documentation only.** |
| Clarification pass | 2026-11-07, still before any approval. Three conditions now stated as evidence rather than as design intent: the reservation invariants SF-1…SF-6 and the five single-flight test classes (P3.2, P5.2, P7, P11, P16, P20); the limits of source fingerprinting and what each verification step does and does not prove (P7, P12, P16 — architecture §6.3a); and the MySQL CI execution plus expected-test-count rules (P2.2, P11, P20, P19's P-10). No decision changed, no ADR moved, D-30 stays open. Architecture side: §16.18 there. **Documentation only.** |
| Implements | §13 "7.1 — Content boundary and journal (backend only)", acceptance criteria 1–11 |
| Verified against | branch `feat/phase6-clerk-postgresql`, Alembic head `0014_external_identities` (re-verified this pass: 14 revisions, one head), `backend/app/services/storage/` present-but-unconsumed (Phase 6.x), `docs/decisions.md` highest ADR-0026 |
| Brief areas covered | all fifteen, one section each — see the map in P0 |
| Approval required before | implementation starts. Sixteen rows in P19 are yours: 7 already approved and closed, 2 redesigned and needing approval (P-6′, P-7′), 7 new. Two of the open rows change what gets built rather than when |

## P0. How to read this plan

- Every `§n.n` reference points at the **architecture document**, never at this
  file. Sections of this plan are named `Pn`, so there is no ambiguity: `§6.4a`
  is the two-pass verification mechanism, `P5` is the migration sequence here.
- `[EXISTING]` marks a fact re-read in the repository for this plan, with a real
  `file:line`; `[PROPOSED]` marks code that does not exist yet. Two things were
  actually executed while writing this revision, both read-only: `alembic heads`
  (one head, `0014_external_identities`, 14 revision files) and a SQLAlchemy
  compile probe that showed `.with_for_update()` emitting `FOR UPDATE` on the
  postgresql and mysql dialects and nothing on sqlite — the facts P5.2 rests on.
  The clarification pass of 2026-11-07 re-ran the same probes plus a
  `CreateTable` render of the §5.2.6a constraint pair: the `CHECK` and the
  composite `UNIQUE` came out character-identical on all three dialects, while
  the surrounding column definitions still differ by dialect — so "no dialect
  branch" is a claim about the constraint pair, and P5.2 says it that way.
  **No test suite, no application server, no database connection and no emulator
  was run**, so nothing in this file is a claim about observed runtime behaviour
  of DataDiet. Where a
  MySQL property is documented rather than measured, P5.2 and P11 say so in the
  row itself.
- The brief's fifteen areas map as follows: (1) P2, (2) P3, (3) P4, (4) P5,  (5) P6, (6) P7, (7) P8, (8) P9, (9) P10, (10) P11, (11) P12, (12) P13,
  (13) P14, (14) P15, (15) P16. The five artifacts the brief additionally
  requires are tables in P2 (file-by-file), P5 (migration dependencies),
  P3 + P4 (API contracts, permission matrix), P17 (state transitions),
  P16 (test coverage) and P18–P19 (risks, open decisions, approvals).
- **What the 2026-11-07 clarification pass changed, and what it did not.** Three
  conditions are now written as evidence rather than as design intent: the
  reservation invariants SF-1…SF-6 with the five test classes that discharge
  them (P3.2's fourth contract decision, P5.2's two tables, P7's two new rows,
  P16 rows 17–18, P17's invariant reading), the limits of source fingerprinting
  with the fail-closed table (P7's attribution table; §6.3a on the architecture
  side), and the MySQL CI execution and expected-test-count rules (P2.2's
  `ci.yml` row, P11's five-field evidence rule, P20's criterion-6 paragraph,
  P19's P-10 and P-12). Nothing else moved: no decision was made, no ADR
  changed status, D-30 stays open, and the scope statement in P21's last row is
  still "two documentation files".
- Where this plan **departs** from the architecture document — and it now
  departs in seven places, D-δ1…D-δ7 — the departure is named in the section,
  listed in P18 with its status, and put up for approval in P19. Silence means
  §13's 7.1 scope is implemented as written. Three of the seven are your own
  mandated corrections (D-δ5, D-δ6, D-δ7), so they are departures from the
  document's *earlier* text, which has already been amended to match.

## P1. What Phase 7.1 is

One sentence: 7.1 builds the two things everything else assumes — a content
boundary that hashes an already-discovered file in one bounded pass, reopens it
in a second under the same fingerprint and streams it through ordered safety
gates, and a journalled, streaming, verified write into Blob Storage whose
single-flight guarantee is enforced by the database rather than by a lookup —
without shipping a single route, page, or new dependency.

| 7.1 delivers | 7.1 deliberately does not deliver |
| --- | --- |
| `app/services/content_access/` with G0–G10 and the `hash_source` / `reopen` / `probe` contract (§3.2, §3.4) | any HTTP route, any schema, any `api/router.py` edit |
| The D-1 parity test that pins allow-list behaviour (§3.2, §16.3) | any edit to `scan.py` or `services/connectors/` |
| `ObjectStorage.put_stream()` / `open_stream()` + native Azure implementations (§3.6) | any consumer that calls `build_object_store` from application code |
| The read-back verification hook (§6.3 step 6, §3.6 closing block) | the delivery-time rule E pass (that is 7.4, using this hook) |
| `storage_operations` + the §11.3 machine + §11.3a retryability + §5.2.6a's lock-and-`active_slot` single-flight pair | archive/evidence tables, version chains, retrieval, holds interaction |
| `derive_object_key()` fed by a completed `HashResult` (§6.1, §6.3 step 3) | any UI, any `frontend/` file, any new `VITE_*` |
| Migrations for `stored_objects` and the journal (P5) | any new dependency, including `python-multipart` (that gate is 7.3's, §16.7) |
| Test coverage for all eleven §13 7.1 acceptance criteria | any deletion path — none is reachable in 7.1 |

After 7.1 the product does **nothing visibly different**: `STORAGE_PROVIDER`
still defaults to `none` (`config.py:139`), the storage SDK is still unimported
(`test_storage_provider.py:567`), and the dormant `ArchiveItem` /
`RetrievalRequest` placeholders stay dormant (`models.py:385-423`). Two new
tables do exist and are empty, with no application writer — which is a real,
reportable state and not "no table" (§1.3's four-way absence table, §13 7.1
criterion 11). That is the correct outcome for a foundation phase, and it is
what makes the phase reversible.

## P2. Area 1 — File-by-file implementation scope

### P2.1 Files created

| Path | What it owns | Basis |
| --- | --- | --- |
| `backend/app/services/content_access/__init__.py` | one entry point, `get_content_accessor(source, settings)`, plus `__all__`; nothing else is importable from outside the package | §3.2 |
| `backend/app/services/content_access/base.py` | `ContentAccessor` ABC (`hash_source`, `reopen`, `probe`), frozen `ContentHandle`, `HashResult`, `SourceFingerprint`, the five exceptions, and `ContentAccessLimits` (P13) | §3.2 |
| `backend/app/services/content_access/local_folder.py` | `LocalFolderContentAccessor`: its own root resolution, gates G0–G10 in order, 1 MiB chunked read, `hashlib.sha256` over a whole pass with the `SourceFingerprint` re-`fstat` at EOF, reopen-fingerprint comparison, declared-vs-detected media cross-check | §3.2, §3.4, §3.6, §3.7 |
| `backend/app/services/storage/keys.py` | `derive_object_key()` and the two named builders (`archive_key`, `evidence_key`); takes a completed digest, and validates its own output with `validate_object_key` (`base.py:81-99`) before returning | §6.1, §6.3 step 3 |
| `backend/app/services/storage/journal.py` | `ALL_STATUSES` / `TERMINAL_STATUSES` / `VALID_TRANSITIONS` for §11.3, `can_transition()` / `transition()`, `InvalidOperationTransition`, `RETRYABLE_ERROR_CODES` (§11.3a), `next_backoff()`, and `lock_operation_subject(db, …)` — the parent-row `SELECT … FOR UPDATE` helper of §5.2.6a Layer 1. `active_operation_exists()` is **not** in this list: it is the rejected P-6 mechanism and 7.1 does not ship it | §11.3, §11.3a, §5.2.6a, I-12 |
| `backend/app/services/storage/verify.py` | `hash_stream()` and `verify_object(store, key, expected_sha256, expected_size_bytes)` → `VerificationResult(outcome, computed, observed, stat_agrees)` with `outcome ∈ {verified, mismatch, incomplete}` | §3.6, §6.3 step 6, §6.4a |
| `database/migrations/versions/0015_stored_objects.py` | create `stored_objects` exactly as §5.2.1, with explicit names for every index and constraint | §5.2.1, §5.5 |
| `database/migrations/versions/0016_storage_operations.py` | create `storage_operations` as §5.2.6, including `active_slot`, the CHECK tying it to the non-terminal state set, and the composite `uq_operation_active_per_subject` UNIQUE — **no partial index, therefore no `op.get_bind().dialect.name` branch in this file** | §5.2.6, §5.2.6a, §5.5, §11.3 |
| `backend/tests/test_content_access.py` | gates G0–G10 refusals (each fixture built outside the repo) **and** the D-1 parity table — one file, deliberately not split | §3.4, §13 7.1 criteria 2–3 |
| `backend/tests/test_object_keys.py` | key derivation: length bound ≤1 024, `validate_object_key` composition, no filename / absolute path / backslash ever, and that a key is only constructible from a finished `HashResult` | §6.1, §13 7.1 criterion 8 |
| `backend/tests/test_storage_journal.py` | every §11.3 transition row, absorbing `NEEDS_RECONCILIATION`, backoff arithmetic, the `active_slot` CHECK one-sided combinations, coexistence of completed operations for one subject, §11.3a retryability table as data | §11.3, §11.3a, §13 7.1 criteria 7 and 9 |
| `backend/tests/test_storage_single_flight.py` | §5.2.6a's proof: two independent `Session` objects on one engine, two threads released by a `threading.Barrier`, the same `(operation_kind, subject_type, subject_id)`, a recording provider stand-in, and the four assertions — exactly one non-terminal row at every observable instant, exactly one provider write attempted, the loser raises `IntegrityError` having inserted nothing, the winner's row untouched. Three dialect variants; the table after this one says which runs where | §5.2.6a, §13 7.1 criterion 6 |
| `backend/tests/test_storage_streaming.py` | peak-RSS bound on a 512 MiB synthetic file **on each pass**, iterator-not-`bytes` at the provider boundary, pass-1-retains-nothing, read-back mismatch ⇒ `FAILED_TERMINAL` + both hashes, the fake's `open_stream()` actually called, and the four between-pass mutations (grown / shrunk / equal-length rewrite / inode swap) failing with zero provider calls | §3.2, §3.6, §13 7.1 criteria 4, 5 and 7 |
| `backend/tests/test_scan_never_ingests.py` | invariant I-8: a completed scan writes no journal row, no object, and opens no content handle (recording fake, not a source grep) | I-8, §13 7.1 criterion 1 |

`journal.py` and `verify.py` land in `app/services/storage/` rather than a new
package because §3.6's rule is that "`app/services/storage/` remains the only
place that knows a provider exists"; the journal is about provider attempts, so
putting it elsewhere would create a second place.

Criterion 6's variants are split by which server the suite already owns,
because that — not ambition — decides what 7.1 can honestly claim:

| Variant | Server | Runs when | What it proves |
| --- | --- | --- | --- |
| SQLite | the temp-file schema from `Base.metadata.create_all`, reached through the existing `db` fixture (`conftest.py:135-139`) with a second `Session` on the same engine | every local run and every CI run | the `CHECK` + composite `UNIQUE` really do refuse the second live row. The `FOR UPDATE` half is **skipped with a printed reason**: SQLite takes no row lock, and §5.2.6a does not claim otherwise |
| PostgreSQL | `pgserver`, using the same acquisition path as `test_migrations_postgresql.py:79` | whenever `pgserver` is installed (it is a dev-only dependency, `test_migrations_postgresql.py:26`); skipped with that file's existing stated reason otherwise | both halves — row lock *and* constraint — against a real server, so the primary guarantee is measured rather than argued |
| MySQL | the disposable CI service, via `MIGRATION_TEST_DB_URL` + `MIGRATION_TEST_ALLOW_DROP` | CI only (`ci.yml:76-96`); locally it skips with the reason the migration suite already prints | the same DDL is accepted **and** enforced on MySQL — the property this revision previously had to describe from documentation |

### P2.2 Files modified

| Path | Exact change | Why it is safe |
| --- | --- | --- |
| `backend/app/services/storage/base.py` | add `_DEFAULT_CHUNK_BYTES = 1 << 20`; add **non-abstract** `put_stream()` and `open_stream()` whose base bodies raise `NotImplementedError` with the provider name, exactly as `ensure_container()` already does (`:152-158`) | `ObjectStorage.__abstractmethods__` is unchanged, so `test_the_interface_exposes_only_the_justified_operations` (`test_storage_provider.py:563-564`) stays green rather than being edited — the contract-stability promise of §15.4 row 7 is enforced by an existing test, not by assertion |
| `backend/app/services/storage/azure_blob.py` | implement `put_stream()` (SDK streaming upload, `overwrite=False`, `_translate` on failure) and `open_stream()` (download-chunks context manager) next to `put` (`:134`) and `get` (`:161`); validate the key before any request, as every existing method does | only the one implemented provider gains streaming; `_IMPLEMENTED` stays `("azure_blob",)` (`__init__.py:47`) |
| `backend/app/services/storage/__init__.py` | export `derive_object_key`, the journal symbols and `verify_object`; `build_object_store` (`:50`) itself is untouched | exports are inert; no application module imports them in 7.1 |
| `backend/app/db/models.py` | add `StoredObject` and `StorageOperation` after `LifecycleAction` (`:359-382`), before the dormant `ArchiveItem` (`:385`); explicit `Index`/`UniqueConstraint`/`CheckConstraint` names in `__table_args__`, matching the file's existing style (`:49`, `:84-86`) — there is **no** metadata naming convention (`Base` at `:29-30`), so every name is spelled out. `StorageOperation.active_slot` carries both the CHECK and the composite UNIQUE of §5.2.6a. | additive; `models.py` has no behaviour to break |
| `backend/tests/test_migrations_postgresql.py` | `HEAD` (`:54`) becomes the new revision id; add the two tables to the `compare_metadata` zero-drift test (`:229`, `:245`); assert the `active_slot` CHECK and the composite UNIQUE are present **on both dialects**, which replaces the partial-index presence/absence assertion this file would otherwise have needed | that file is the only place a real PostgreSQL server is used, and `diffs == []` is what catches a model/migration disagreement |
| `backend/tests/test_migrations_mysql.py` | the five literal `"0014_external_identities"` expectations (`:134`, `:204`, `:265`, `:303`, `:314`) become the new head, **and** two new tests land here: the `active_slot` CHECK + composite UNIQUE present in MySQL's applied schema, and criterion 6's two-session barrier variant. Both increase the file's test count, which is what makes CI's hard literal wrong until it is re-measured (the `.github/workflows/ci.yml` row below and item **P-10**) | MySQL remains the production-compat surface (§13 7.1 criterion 9) and is the only place the MySQL-side claims stop being documented properties |
| `backend/tests/test_migration_preflight.py` | `HEAD` (`:24`) becomes the new head | the preflight test asserts a single, named head |
| `backend/tests/test_storage_provider.py` | extend `test_the_default_app_never_imports_the_storage_sdk` (`:567`) to import `content_access`, `keys`, `journal`, `verify` too; add mocked `put_stream`/`open_stream` cases | §13 7.1 criterion 10 asks for exactly this extension rather than a new file |
| `backend/tests/test_storage_floci_integration.py` | add stream-upload + read-back + `open_stream` round-trips inside the existing opt-in guard (`:42`) and loopback assertion (`:76`) | the emulator stays a functional surface only (P11) |
| `.github/workflows/ci.yml` | the MySQL gate is a **hard literal count**: the step name `MySQL migration integration tests (19 expected)` (`:76`) and `MIGRATION_TEST_EXPECTED_TESTS: "19"` (`:85`), enforced by the `grep -Eq "${expected} passed"` guard (`:93-96`). Every MySQL test 7.1 adds — criterion 9's constraint-presence pair and criterion 6's two-session barrier — makes that literal wrong, and CI then **fails rather than silently skipping**. So the count is re-measured from the first local gated run and both places updated in the same change. The rule that governs the edit: the number must reflect the **real test inventory**, and no existing test may be weakened, skipped, marked xfail or deleted to make the count agree — lowering the bar to match a diff is the failure mode this row exists to prevent | this is the only CI edit in 7.1, it widens coverage instead of narrowing a gate, and it is item **P-10** in P19 — it is *not* covered by "no configuration change", which is why it is listed rather than assumed |
| `backend/app/core/config.py` | **only if P-4 is approved**: the two fail-closed settings of P13 | otherwise untouched |
| `.env.example` | only with the above: two documented variables beside the storage block (`.env.example:114-168`) | there is no `backend/.env.example`; this is the only such file |
| `docs/decisions.md` | **at handoff, never at planning**: ADR-0027, ADR-0028 and ADR-0040 move from *Proposed* to *Accepted* with a one-line note each pointing at the implementation and the test run that passed (next free number is 0027, after ADR-0026 at `docs/decisions.md:320`). ADR-0030 and ADR-0037 stay *Proposed* — they describe the archive-item version chain and the re-archive path, which 7.2 implements. §14.1's acceptance rule is the gate; P20 restates it | AGENTS.md definition-of-done item 5 (`:98`) requires the record once the decision is real code — and §14.1 requires the real code first, which is exactly the defect the revised P-7 fixes |
| `docs/architecture.md` | one status line in §13 criterion 11's shape: content boundary + streaming/read-back hooks + journal exist; `stored_objects` and `storage_operations` exist **with no application writer yet**; no archive or evidence route exists and no workflow consumes either table. The phrase **"no route, no table, no consumer" is prohibited** — after this phase there *are* tables, and calling their absence a conservative statement erases the migration that shipped them (§1.3's four-way absence table) | prevents the "implemented but invisible" drift that rule 3 (`AGENTS.md:13`) is about; under-claiming is the direction this correction guards |
| `docs/setup.md`, `docs/render-staging.md`, `docs/production-readiness.md` | the head string appears at `docs/setup.md:89` and `:110`, `docs/render-staging.md:341`, `docs/production-readiness.md:50` and `:499` | these are operator instructions; a stale head is a wrong command |

### P2.3 Files that must stay byte-identical

Prohibited by the brief, by §15.4, or by resolved D-1 — and each is checkable:

| Path | Prohibition | How 7.1 proves it |
| --- | --- | --- |
| `backend/app/services/scan.py` | untouched by any archive phase (D-1 withdrew the `resolve_approved_root()` extraction, §3.2) | `git status --porcelain` in the handoff; no import of `content_access` anywhere in it |
| `backend/app/services/connectors/**` | `SourceConnector` keeps exactly `validate`, `check_access`, `iter_batches` (`base.py:73-86`); no content method ever | `test_scan_never_ingests.py` + I-8's recording fake; criterion 1 |
| `backend/app/core/auth.py` | no permission name, no role, no helper changes in 7.1 | P4's test reads `ROLE_PERMISSIONS` (`:119-129`) and `ALL_PERMISSIONS` (`:79-93`) and asserts the archive vocabulary is absent |
| `backend/app/api/**` | no route, no schema, no router edit | `git status`; the OpenAPI snapshot in existing tests is unchanged |
| `database/migrations/versions/0001…0014` | history is never rewritten; forward-only | the new revisions' `down_revision` chain has one head |
| `backend/requirements.txt`, `requirements-dev.txt` | no dependency added in 7.1 (`python-multipart` is 7.3's request, §16.7) | P15's table plus a pip-freeze check in the handoff |
| `frontend/**` | zero files (P14) | `git status --porcelain frontend` is empty |
| `infra/**`, Floci configuration or data | "Do not touch Floci infrastructure or its data" | tests only address the already-running emulator over loopback, keys from env, and no `infra/` file opens |
| `.github/workflows/**` except the two MySQL count literals of P2.2 | no new CI step, no job reordered, no secret added, no gate loosened — the edit *tightens* the MySQL gate's accuracy and nothing else | `git status` shows one workflow file with a two-line diff; the step name and the `env` value are the only changed tokens |
| Phase 6.x storage work (`services/storage/*`, its tests, the storage block of `config.py`) | preserved as uncommitted work; extended, never reverted | every edit above is additive to those files |

### P2.4 Deviations from §3.2's file list

§3.2 lists `content_access/upload.py` (`UploadScratch`). **7.1 does not create
it.** The spool's only writers are the evidence upload route (7.3) and the
delivery route (7.4); creating it in 7.1 would ship code with no caller and no
test that is not a self-referential mock. This is a narrowing of §3.2's *end
state* list, not of §13's 7.1 scope (which never mentions the spool), and it is
item **P-2** in P19.

## P3. Area 2 — API routes, contracts and authorization checks

### P3.1 Routes shipped: none

§13's 7.1 says "Explicitly not in this phase: any route, any UI", and the
endpoint matrix confirms the ownership split. Recorded here so nobody "starts
with a health-style endpoint":

| §8.2 rows | Route family | Owning phase |
| --- | --- | --- |
| 1–5, 27 | `/archive/items*`, `/probe`, `/retire`, `/versions` | 7.2 |
| 6, 14 | the two content routes (rule A / rule E) | 7.4 |
| 7–13, 15, 26 | `/evidence*`, `/evidence/upload-constraints` | 7.3 |
| 16–20 | `/retrieval-requests*` | 7.4 |
| 21–25, 28 | `/storage/operations*`, `/integrity*` | 7.5 |

### P3.2 The contracts 7.1 must pin now

7.1's "API" is its internal surface, and it is pinned because five later phases
call it. These are the exact signatures 7.1 ships (they follow §3.2 and §3.6,
with the parameter choices recorded rather than discovered later):

| Contract | Shape | Consumed by |
| --- | --- | --- |
| `get_content_accessor(source: DataSource, settings: Optional[Settings] = None) -> ContentAccessor` | returns `LocalFolderContentAccessor` for `connector_type == "local_folder"`, `None` for `synthetic` (the caller turns that into `409 content_unavailable:synthetic_source`, §13 7.2 criterion 4) | 7.2 |
| `ContentAccessor.hash_source(record: InventoryRecord) -> HashResult` | **pass 1** — the only operation that produces a digest; bounded memory, retains nothing after returning | 7.2, 7.3 |
| `ContentAccessor.reopen(record: InventoryRecord) -> ContentHandle` | **pass 2** — takes the ORM record, never an id (P3.3); re-verifies the `SourceFingerprint` against pass 1's before yielding the first byte | 7.2, 7.3 |
| `ContentAccessor.probe(record) -> tuple[bool, str]` | no byte read; the same gate order, stopping at the first refusal | 7.2 (`/probe`) |
| `ContentHandle` | frozen dataclass: `read(size)`, `size_bytes`, `media_type`, `modified_at`, `close` (§3.2). **There is no `sha256` field and none may be added back**: a handle is produced lazily, before any digest exists, and a field that can only be correct after the last chunk has been read would be either always `None` or a promise to buffer the file — both of which are the P-6-class defect this revision removes | 7.2, 7.3 |
| `HashResult` / `SourceFingerprint` | `HashResult(sha256, fingerprint, media_type, modified_at)`; `SourceFingerprint(size_bytes, mtime_ns, device, inode)` — the fingerprint is how "did the source change between passes?" (W11) becomes answerable without reading the file twice for a second reason | 7.2, 7.3, 7.5 |
| `ObjectStorage.put_stream(key, stream, *, size_bytes, content_type=None, overwrite=False) -> ObjectMetadata` | accepts an iterator of `bytes`, never a whole body; returns provider metadata | 7.2, 7.3 |
| `ObjectStorage.open_stream(key, *, chunk_bytes=1 << 20) -> ContextManager[BinaryIO]` | usable with **no request context** — verify, sweep and delivery all call it outside an ingest (§3.6) | 7.2, 7.4, 7.5 |
| `verify_object(store, key, *, expected_sha256, expected_size_bytes) -> VerificationResult` | one `stat` + one full streamed read; three outcomes only; **reads no configuration** (P16's "never" assertion) | 7.2, 7.4 (rule E), 7.5 |
| `derive_object_key(kind, *, institution_id, asset_id=None, evidence_uid=None, version=None, content_sha256) -> str` | §6.1's two content templates; validates its own output. The `content_sha256` parameter is **the completed digest of a `HashResult`** — §6.3 step 3 — never a value still being computed, and never a filename-derived stand-in | 7.2, 7.3 |
| `journal.lock_operation_subject(db, *, kind, subject_type, subject_id) -> None` | the approved replacement for check-then-insert (§5.2.6a layer 1): `SELECT … FOR UPDATE` on the parent row inside the caller's transaction, so the serialisation is the database's, not the code's | 7.2, 7.3, 7.4, 7.5 |
| `journal.open_operation(db, *, kind, subject_type, subject_id, requested_by, correlation_id, object_key=None, checksum_sha256=None, size_bytes=None) -> StorageOperation` | writes `PENDING` with `active_slot = 1` and commits on its own (§6.3 step 1); raises `IntegrityError` on a live-op collision, which the caller turns into `409 operation_in_progress` (§6.3 step 10) | 7.2, 7.3, 7.4, 7.5 |
| `journal.transition(op, target, *, error_code=None, error_message=None) -> None` | **the only writer of `state` and `active_slot`, and it sets both in one `UPDATE`** (SF-4): the target state decides the slot value, and there is no parameter that overrides it. Raises `InvalidOperationTransition` (§11.3 rule set) | all |
| `journal.RETRYABLE_ERROR_CODES` | a table, not per-call-site heuristics (§11.3 rule 1) | the retry helpers |

Four contract decisions worth stating explicitly because they are cheap now and
expensive later:

1. **`verify_object()` performs no policy.** It reports `verified` / `mismatch` /
   `incomplete` and nothing else. Rule E's "cannot complete ⇒ fail closed" and
   rule A's "above the ceiling ⇒ stream marked unverified" (§6.4) are decisions
   made by their callers in 7.4 and 7.5. That separation is what lets T-20 be
   tested rather than hoped for.
2. **The journal never touches the container.** No function in `journal.py`
   takes an `ObjectStorage`. A future reader cannot mistake a journal write for
   a side effect, which is the mistake §11.3a's `verification_unavailable`
   exception exists to prevent.
3. **Single-flight has no query-only form.** `journal.py` exports
   `lock_operation_subject()` and the `active_slot` constraint constants, and
   deliberately does **not** export an `active_operation_exists()` helper. A
   caller that wants "is someone already doing this?" must take the lock and let
   the insert answer; there is no boolean-returning function to reach for, so
   the rejected P-6 pattern cannot be reintroduced by a future caller who found
   a convenient predicate. §13 7.1 criterion 6 is what keeps that promise real.
4. **The reservation has no separate home** (SF-5). `active_slot` is a column of
   the operation row, so a rolled-back transaction drops the operation and its
   gate together and there is nothing to clean up; 7.1 therefore creates no
   reservations table, no lock rows and no advisory-lock call, and none may be
   added later as a "simplification" — a second table would need its own
   rollback story, which is precisely how a gate can outlive the work it
   guarded. Test class 3 (P5.2, §5.2.6a) asserts the zero count three different
   ways rather than trusting the reasoning above.

### P3.3 Authorization checks in 7.1

7.1 exposes no HTTP surface, so it performs **no** authorization — and that is a
design point, not an omission. The mechanism that keeps 7.2–7.5 honest is the
parameter type: `hash_source()`, `reopen()` and `probe()` all take an
`InventoryRecord` instance. A caller can only
hold one after it went through row scope, because scope resolution already exists
and is reused unchanged (`resolve_institution_scope` at `auth.py:671`,
`ensure_institution_access` at `:709`, and the "404, not 403" semantics of §7.3).
Nothing in `content_access/` imports `app.core.auth`, and a 7.1 test
asserts that: a package that could authorize would be a second, divergent
implementation of the same decision.

`content_access` also refuses structurally: it resolves its own root from
`settings.local_source_roots` (`config.py:79`, empty by default ⇒ refuse) and
never accepts a path, per I-1.

### P3.4 Error codes produced in 7.1

`content_access` raises the five exceptions of §3.2, and each maps to the §8.4
string that 7.2 will return — mapped once here so that no route invents a code.
The last three rows are the storage- and journal-layer codes, included for the
same reason: they are the strings 7.2 will return, and pinning them here is what
stops a route from coining a near-synonym.

| Exception | §8.4 / §3.4 code | HTTP status it will produce (7.2+) |
| --- | --- | --- |
| `ContentUnavailableError("synthetic_source")` | `content_unavailable:synthetic_source` | 409 |
| `ContentUnavailableError("no_mapping"/"root_unapproved"/"not_regular"/"path_gone"/"empty_file")` | `content_unavailable:*` | 409 |
| `ContentPathRejectedError(...)` | `content_path_rejected`, with `:symlink` / `:escaped_root` naming the gate | 422 |
| `ContentChangedError(...)` — drifted since discovery (**pass 1** gate) | `content_changed` | 409 |
| `ContentChangedError(...)` — fingerprint differs between pass 1 and pass 2 (**W11**, §6.3 step 12) | `content_changed` | 409; the journal ends `FAILED_TERMINAL` and **zero provider calls were made** |
| `ContentTooLargeError(...)` | `content_too_large` | 413 |
| `ContentMediaRejectedError(...)` — G10's refusal, §3.4's `content_media_rejected` | same | 415 |
| `StorageUnavailableError` (`base.py:45`) | `storage_unavailable` | 503 |
| `InvalidOperationTransition` (journal-only) | never an HTTP code; a programming error, raised, not swallowed | — |
| read-back disagreement from `verify_object()` | `checksum_mismatch` (journal `FAILED_TERMINAL`, §6.3 step 11) | 409 |
| `IntegrityError` on step 1's insert (live op for the same subject) | `operation_in_progress`, naming the winner's `correlation_id` (§6.3 step 10, §11.3a) | 409 |

§3.2's illustrative exception list has four subclasses and §3.4's table needs a
fifth for G10, so `ContentMediaRejectedError` is added to §3.2's set — recorded
as departure **D-δ1** in P18 rather than folded into `ContentPathRejectedError`,
because a media refusal is not a path refusal and the UI must be able to say so
(§9.5).

Two wording rules come with this table, both from §6.3a. `content_changed`
means *the metadata observed at two instants differs* — it is the detection code,
and it must never be documented or logged as proof that the source was
immutable, because a rewrite that restores size, `mtime_ns` and the inode is
indistinguishable to it. `checksum_mismatch` is the code that carries the
integrity claim, because it comes from re-reading the provider's own bytes; the
two rows above that share a code (`content_changed` at pass 1's gate and at W11)
share a meaning too — refuse, journal `FAILED_TERMINAL`, make no second attempt
against a different digest, and leave whatever the provider already holds for
the sweep rather than deleting it.

## P4. Area 3 — Permissions

**7.1 adds zero permission names and grants zero permissions.** That is
consistent with I-13 ("a permission is a name before it is a grant") and with
§7.4a's split: a name is only useful once a route enforces it, and 7.1 ships no
route. Adding the eight strings in 7.1 would create permission names that no
`require_permission` (`auth.py:595`) ever references — an unenforced surface that
looks like capability.

| Permission (proposed constant) | Registered by phase | Enforced first at | Role grants |
| --- | --- | --- | --- |
| `PERMISSION_ARCHIVE_READ = "archive:read"` | 7.2 | §8.2 rows 1, 3, 4, 27 | none |
| `PERMISSION_ARCHIVE_WRITE = "archive:write"` | 7.2 | rows 2, 5 | none |
| `PERMISSION_EVIDENCE_READ = "evidence:read"` | 7.3 | rows 7, 9, 15, 26 | none |
| `PERMISSION_EVIDENCE_WRITE = "evidence:write"` | 7.3 | rows 8, 10–13 | none |
| `PERMISSION_RETRIEVAL_READ = "retrieval:read"` | 7.4 | rows 16, 18 | none |
| `PERMISSION_RETRIEVAL_REQUEST = "retrieval:request"` | 7.4 | rows 17, 20 | none |
| `PERMISSION_RETRIEVAL_DECIDE = "retrieval:decide"` | 7.4 | row 19 | none |
| `PERMISSION_STORAGE_MANAGE = "storage:manage"` | 7.5 | rows 21–25, 28 | none |

The naming follows the existing convention exactly: constants at
`auth.py:67-77`, membership in `ALL_PERMISSIONS` (`:79-93`), and `ROLE_PERMISSIONS`
(`:119-129`) **not** touched — the mechanism by which platform admins gain access
with no role change is the `ALL_PERMISSIONS` grant at `auth.py:564-565`, and that
is resolved D-15 part 1.

Two facts a reviewer should not have to rediscover:

- `VALID_ROLES` is derived from `ROLE_PERMISSIONS` (`auth.py:131`) and `_role_rank`
  hardcodes three roles (`:580`), so any *new role* is a whole-repository edit.
  This plan proposes none (§7.4a's third guarantee).
- Part 2 — any cell of §7.4a's least-privilege matrix becoming real — is decision
  **D-28** and needs ADR-0041 plus explicit approval. Until then the entire
  archive feature is demoable only as a platform admin. 7.1 changes nothing about
  that, and 7.1's own test proves nothing was granted:

```
test_no_permission_name_exists_yet  (7.1)
  assert not ({"archive:read", …, "storage:manage"} & ALL_PERMISSIONS)
  assert ROLE_PERMISSIONS == {viewer: …, reviewer: …, admin: …}   # unchanged sets
```

## P5. Area 4 — Migration sequence `0015`–`0020`

### P5.1 The numbering conflict, stated before anything is built

Before P-1 was approved, §13 assigned 7.1 the revisions `0015` **and** `0019`.
Alembic cannot honour that
in a single-head repository: `0019`'s `down_revision` must point at an existing
revision, and the chain order — not the numeric prefix — is what `upgrade head`
walks. `test_the_repository_has_exactly_one_head`
(`test_migrations_postgresql.py:172-174`) asserts `get_heads() == [HEAD]`, and
`test_multiple_heads_is_an_ambiguous_repository`
(`test_migration_preflight.py:270-272`) exists precisely to punish branching.
So the choices are: three empty placeholder revisions (rejected: dead code that
`upgrade head` still has to run), a non-monotonic chain (rejected: the existing
14 revisions are strictly monotonic, and `revision` id equals filename stem —
silently breaking that convention is worse for the next operator than renaming),
or **renumber so that chain order equals phase order**. This plan proposes the
last one.

| Revision (proposed id) | down_revision | Created by | Phase that ships it | §5.5/§15.2's old label |
| --- | --- | --- | --- | --- |
| `0015_stored_objects` | `0014_external_identities` | **7.1** | 7.1 | `0015_stored_objects` (same) |
| `0016_storage_operations` | `0015_stored_objects` | **7.1** | 7.1 | was `0019_storage_operations` |
| `0017_archive_items` | `0016_storage_operations` | 7.2 | 7.2 | was `0016_archive_items` |
| `0018_evidence` | `0017_archive_items` | 7.3 | 7.3 | was `0017_evidence` |
| `0019_retrieval_requests` | `0018_evidence` | 7.4 | 7.4 | was `0018_retrieval_requests` |
| `0020_audit_entity_index` | `0019_retrieval_requests` | 7.5 | 7.5 | `0020` (same) |

Dependencies are satisfied in this order because the two tables that other
revisions reference are created first: `archive_items.stored_object_id` and
`.operation_id` are FKs into `stored_objects` and `storage_operations`
(§5.2.2), so `0017` must follow both — which the old numbering got right too,
accidentally. The one real change besides labels is that §13's "7.2 … `0018`
(partial)" — `0018` under the *old* label set, the retrieval widening now numbered
`0019` — disappears: `retrieval_requests` is widened wholly by 7.4, which is
what §13's own 7.4 scope sentence says ("`retrieval_requests` widening"). This
was departure **D-δ2**, and **it is now closed**: P-1 was approved, and §5.5,
§13 and §15.2 of the architecture document carry the linear numbering above.
§16.17 recorded the correction, and the 2026-11-07 clarification pass swept the
rest of the stale labels: §13's phase table still assigned `0019` to 7.1 and
`0016` to 7.2, contradicting §5.5 and §15.2 — the three now agree — and four
sentences in §5.5, §5.6, §11.2 and ADR-0033 still attributed the retrieval
CHECK and its avoided data rewrite to `0018`, which now names the evidence
revision; they read `0019_retrieval_requests`, while the rows that legitimately
put the guarded partial indexes in `0017` and `0018` (the D-30 gap) are
unchanged. The architecture record is §16.18. The head was re-verified for this
pass — 14 revision files, exactly one head, `0014_external_identities` — and
item **P-1a** in P19 keeps the standing requirement to re-run `alembic heads`
immediately before writing `0015`, because an unrelated revision could take the
number first.

### P5.2 What 7.1's two revisions contain

`0015_stored_objects` — §5.2.1 verbatim: 17 columns, `UNIQUE (object_key)`,
`ix_stored_objects_institution_checksum`, `ix_stored_objects_state`,
`ix_stored_objects_institution`, FK `institution_id → institutions.id` with
`ondelete="RESTRICT"` (the existing pattern for that guarantee is
`models.py:391-393`). Portable DDL, no partial index, no CHECK — so it applies
identically on PostgreSQL and MySQL, like `0014_external_identities.py:21-24`
already documents for itself.

`0016_storage_operations` — §5.2.6: 23 columns (the 22 of the earlier draft plus
`active_slot`), the five named `ix_operations_*` indexes including
`ix_operations_claimable (state, available_at)`, and the single-flight pair of
§5.2.6a — a `CHECK` binding `state` to `active_slot` plus a plain composite
`UNIQUE uq_operation_active_per_subject (operation_kind, subject_type,
subject_id, active_slot)`. **There is no partial index in this revision, and
therefore no `op.get_bind().dialect.name` branch** — and the honest scope of
"identical DDL" is the *constraint pair*: re-rendered at the 2026-11-07 pass, the
two `CONSTRAINT` clauses came out character-identical on SQLite, PostgreSQL and
MySQL, while the column definitions above them still differ as dialects require
(`SERIAL` against `INTEGER AUTO_INCREMENT`). No test may assert that the whole
`CREATE TABLE` is byte-equal; the property that matters — and the one that made
the earlier design unverifiable on MySQL — is that the guard is stated the same
way everywhere.

| Dialect | How the single-flight rule is expressed | Checked this pass / documented |
| --- | --- | --- |
| PostgreSQL | `FOR UPDATE` on the parent `inventory_records` row (§5.2.6a layer 1) **and** the `UNIQUE` + `CHECK` pair (layer 2) | layer 1 measured: SQLAlchemy 2.1.6 compiles `.with_for_update()` to `SELECT … FOR UPDATE` on the postgresql and mysql dialects and emits nothing on sqlite; layer 2 created and enforced by a real `pgserver` server in `test_migrations_postgresql.py` |
| MySQL | identical DDL for layer 2; layer 1 is the same statement and is the *primary* guarantee | the DDL is portable by construction. Three MySQL properties this design relies on are **documented, not measured locally**: `CREATE INDEX … WHERE` is parsed and the predicate discarded (which is why the partial index was dropped), table `CHECK` is enforced from 8.0.16 (CI runs `mysql:8.4`, `ci.yml:32-47`), and a `UNIQUE` treats multiple `NULL`s as distinct (which is what lets completed operations coexist). §13 7.1 criterion 6 is the test that converts these from documentation into evidence, it runs only under `MIGRATION_TEST_DB_URL` (`ci.yml:76-96`), and P11's five-field rule says how its result — not its existence — is reported |
| SQLite (the default test database) | the same `CHECK` + composite `UNIQUE`, declared in `__table_args__` (`models.py`) | SQLite enforces `CHECK` and treats `NULL`s in a `UNIQUE` as distinct, so the local suite exercises the real constraint on every run — including the four one-sided `state`/`active_slot` combinations criterion 7 asks for |

Three consequences of that table that must be in the handoff report rather than
buried: (a) `compare_metadata` drift is checked on PostgreSQL only
(`test_migrations_postgresql.py:229`), so the new constraint pair is asserted by
named tests on **both** server-backed files rather than trusted to the drift
diff; (b) the design no longer depends on an application-level existence check
at all — `journal.active_operation_exists()` is not written, the loser of a
race is refused by `IntegrityError` at insert and rolls back having inserted
nothing (§11.3a), and re-reading the winner is only how the `409` message learns
the winner's `correlation_id`, never how the duplicate is prevented; (c) the
MySQL branch of criterion 6's test is skipped in a local run without
`MIGRATION_TEST_DB_URL`, so the honest 7.1 handoff sentence is "enforced and
proved on PostgreSQL and SQLite; enforced by identical DDL and proved in CI on
MySQL" — designed and dialect-verified, not locally MySQL-executed. **That CI
clause is a condition, not a formality:** the barrier test must actually execute
against MySQL, and if the job is unavailable, errors, or the test is skipped,
the handoff reports the MySQL half of the invariant as *unverified*, with the
reason (§15.5's execution rule, P11, P20).

**The six reservation invariants.** §5.2.6a states them as SF-1…SF-6; 7.1's
obligation is to turn each into a test rather than leave it as a property of the
prose, so they are repeated here in implementation terms:

| | Invariant | What 7.1 must therefore do |
| --- | --- | --- |
| SF-1 | each of `PENDING`, `RUNNING`, `VERIFYING`, `RETRY_WAIT`, `NEEDS_RECONCILIATION` carries a non-null `active_slot` | `open_operation()` writes `1`, and `transition()` derives the gate from the target state rather than from a caller argument |
| SF-2 | each of `SUCCEEDED`, `FAILED`, `FAILED_TERMINAL`, `ABANDONED` carries `NULL` | the same derivation is the only path into a terminal state, and the `CHECK` refuses anything else |
| SF-3 | `NEEDS_RECONCILIATION` is active **and** absorbing, so it retains its reservation until an explicitly defined recovery or administrative resolution exists | 7.1 ships no release from that state — no expiry, no retry, no restart clears the gate. The sweep (7.5) and an operator decision are the only exits, so 7.1's test asserts their absence |
| SF-4 | state and gate change atomically, in one statement inside one transaction | `journal.transition()` is the sole writer of both columns; a helper that updated one alone would be rejected in review, and class 4 proves the `CHECK` catches it |
| SF-5 | a failed or rolled-back transaction leaves no reservation standing without its operation row | the reservation lives *in* the row (P3.2's fourth contract decision), so there is nothing to sweep, and class 3 asserts a zero count after each of three failure modes |
| SF-6 | the parent-row lock and the constraint pair are complementary; neither is a substitute for the other | both ship together, and removing either is a design change needing approval. Without layer 2 the two inserts both succeed wherever the lock is ignored — SQLite emits nothing for `FOR UPDATE`, and `integrity_verify` / `reconcile_sweep` have no parent row to lock. Without layer 1 two requests can pass the lifecycle, hold and fingerprint guards against the same snapshot and diverge only afterwards, which makes the winner a matter of timing rather than of record |

**The five test classes that prove them** (§5.2.6a's classes, mapped to the
files that carry them):

| Class | Test | File | Criteria |
| --- | --- | --- | --- |
| 1 — constraint combinations | `state`/`active_slot` pairs inserted directly with no service code: the five active and four terminal combinations accepted, every one-sided pair refused, including `active_slot = 2` and a `RUNNING` row with `NULL` | `test_storage_journal.py`, all three dialects | 7 |
| 2 — two-session concurrency | barrier-released sessions on one engine for one subject: exactly one live row, one provider write, the loser raising `IntegrityError` having inserted nothing, the winner untouched | `test_storage_single_flight.py` | 6 |
| 3 — rollback leaves no orphan | the reservation is taken and the transaction dies three ways — injected exception after the `PENDING` insert, explicit `rollback()`, and class 2's refusal — each ending with zero rows and zero reservations for that subject | `test_storage_single_flight.py` | 6 |
| 4 — terminal release is atomic | each terminal state re-read in one snapshot with the gate `NULL`, after which a fresh operation on the same subject is accepted; plus a state-only update that raises the `CHECK` and leaves the row exactly as it was | `test_storage_journal.py` | 7, 9 |
| 5 — absorbing-state occupancy | `NEEDS_RECONCILIATION` keeps `active_slot = 1`, a second request is refused `409 operation_in_progress`, and no timeout, retry or expiry releases the subject | `test_storage_journal.py` | 9 |

Classes 1, 3, 4 and 5 are the ones a partial implementation tends to skip as
restatements of class 2. They are not: class 2 shows the mechanism refusing a
duplicate, while the other four show it holding across a rollback, releasing
correctly on completion, and refusing to release on an unproven outcome. A 7.1
handoff reporting only classes 1 and 2 has described the invariant, not proved
it.

### P5.3 Rules inherited from §5.5 (all still binding)

Additive only; `server_default` for every NOT NULL column; each revision ships
with a PostgreSQL (`pgserver`) **and** a MySQL application test; no `downgrade()`
may claim to restore content state; existing history untouched, including
`0013`'s MySQL no-op. §5.5 rule 2's `archive_items.institution_id` trap does not
apply to 7.1 — neither new table widens an existing one.

### P5.4 Forward recovery

| Situation | Recovery | Evidence available in 7.1 |
| --- | --- | --- |
| Revision fails on PostgreSQL | nothing applied: the whole revision is one transaction, so re-run `alembic upgrade head` | `test_migrations_postgresql.py` upgrades against a real server |
| Revision fails midway on MySQL | DDL is auto-committed per statement, so a **partial** schema is possible. Both 7.1 revisions create exactly one table each, so partial state = at most one orphan empty table plus an unadvanced `alembic_version`. Recovery: `python scripts/migration_preflight.py` to see the real current revision and pending set, then the operator drops the orphan table by hand and re-runs | `scripts/migration_preflight.py` is dialect-aware (`SUPPORTED_BACKENDS`), and `POSTGRES_BASELINE_REVISION` (`:72`) is unaffected by these ids |
| Someone later adds an unrelated `0015` first | §5.5's own warning. The plan's answer is that 7.1's revisions take the next free numbers **at implementation time** and the table above is re-labelled accordingly; the chain shape does not change | `test_the_repository_has_exactly_one_head` catches a branch immediately |
| A deployment upgrades and never writes a row | `stored_objects` / `storage_operations` stay empty; no route reads them in 7.1 | the tables have no consumer until 7.2 |
| Rollback | `downgrade()` drops the two tables and their indexes only, and its docstring must state that this is safe **only while no consumer exists** — true for 7.1, false from 7.2 onward, when the honest statement becomes "refuses" | mirrors `0014`'s docstring discipline (`0014_external_identities.py:25-30`) and `0013`'s forward-only refusal |

No data migration, no backfill and no `execute("UPDATE …")` appears anywhere in
7.1 — the backfill that D-13 requires (`archive_uid` per row, §5.5) belongs to
7.2 and is empty-table-by-construction there.

## P6. Area 5 — Lifecycles: upload, ingestion, verification, retrieval, deletion

| Lifecycle stage | What 7.1 implements | What 7.1 leaves for later, and where |
| --- | --- | --- |
| **Upload** (client bytes → server) | nothing. The spool, `multipart`, `POST /evidence` and `GET /evidence/upload-constraints` are 7.3's (§6.3's spool rules, §8.3.2, §16.7) | 7.3; `python-multipart` approval first |
| **Ingestion** (content → container) | the whole *mechanism*, in §6.3's order: lock + journal `PENDING` commit → **pass 1** `hash_source()` → key derivation → **pass 2** `reopen()` (fingerprint must match) → `put_stream(..., overwrite=False)` → **pass 3** `stat` + read-back → `VERIFYING` → result. §6.3 steps 1–6, and steps 9, 11 and 12 (the failure paths) | §6.3 step 4 (dedup `SELECT`) and step 8 (the one PostgreSQL transaction that inserts `stored_objects` + `archive_items` and clears `active_slot`) are 7.2's, because 7.2 owns those tables' writers — 7.1 ships the constraint set and the machine, not the commit |
| **Integrity verification** | `verify_object()` + the `QUARANTINED`/`FAILED_TERMINAL` vocabulary it reports (§3.6, §6.3 step 11, §11.1's entry rule) | ingest commits it in 7.2; rule E's two-pass release uses it in 7.4 (§6.4a); the periodic sweep and `POST /integrity/verifications` are 7.5 (§6.9) |
| **Retrieval** | nothing. `retrieval_requests` stays the dormant placeholder with its `"pending"` default (`models.py:417`) | widening + routes + grant model + `deferred` are 7.4 (§7.6, §11.2) |
| **Deletion** | nothing reachable: no caller of `ObjectStorage.delete()` (`base.py:141`) is added, and `DELETE_PENDING`/`DELETED` are not entered by any 7.1 code path | retirement is 7.2's route, operator-approved removal is 7.5's (§6.5); AGENTS.md rule 1 and D-14 keep it non-automatic forever |

The one lifecycle decision 7.1 must make for later phases is the **state the
object row is created in**: §5.2.1 defaults `stored_objects.state` to
`PENDING_WRITE`, and §11.1/§6.8 allow exactly one edge into `AVAILABLE` — a
completed read-back. 7.1 cannot commit that edge (no table writer), so it
instead pins the machine: `journal.py` has no path from `VERIFYING` to
`SUCCEEDED` without a `verified` outcome, and `verify_object()` returns
`incomplete` rather than `verified` when the read is truncated. The commit-side
guarantee ("an object cannot reach `AVAILABLE` without `verified_at`") is then a
7.2 acceptance criterion that 7.1's mechanism makes straightforward, not a
promise this phase has to keep alone.

## P7. Area 6 — Idempotency, concurrency, retry and crash recovery

| Mechanism | 7.1 implementation | Test |
| --- | --- | --- |
| Journal-first | `open_operation()` commits `PENDING` in its own transaction before any provider call, and that commit is what releases the §6.3 step 1 row-lock (§6.3 step 1, §5.2.6a layer 1) | the row survives a simulated crash injected immediately after |
| Deterministic keys | `derive_object_key()` is pure and **takes a completed `HashResult`**: same inputs ⇒ same key, so two crashes in one operation compute the same object (§6.1's "Deterministic" row) | property-style test over both templates + criterion 8's "never from a partial digest" |
| `overwrite=False` | mandatory at the `put_stream` call site; `ObjectAlreadyExistsError` (`base.py:57`) is a **decision**, never a retry (§3.8) — same hash ⇒ converge, different ⇒ `FAILED_TERMINAL` | both branches, mocked provider |
| Single-flight | two layers, both database-side (§5.2.6a): `lock_operation_subject()` takes `FOR UPDATE` on the parent row inside the transaction, and the `CHECK` + composite `UNIQUE (…, active_slot)` pair refuses a second live operation even if the lock is bypassed. No application-level existence check exists in 7.1's code or in its export list. SF-1…SF-6 are the contract; the two layers are complementary and neither alone is the guarantee | criterion 6's two-session barrier test (class 2), the rollback cases (class 3) and criterion 9's completed-operation coexistence |
| Reservation atomicity and rollback | `journal.transition()` writes `state` and `active_slot` in one statement in one transaction (SF-4), and because the gate is a column of the operation row, a transaction that dies takes its reservation with it (SF-5) — which is why 7.1 adds no reservations table and no advisory lock | class 4 (state-only update raises the `CHECK`; terminal release re-read in one snapshot) and class 3 (zero rows after three failure modes) |
| Between-pass drift | pass 2's `reopen()` re-stats and compares the `SourceFingerprint` against pass 1's before yielding a byte, so the second read cannot silently describe different content than the first. §6.3a is the limit of that claim: it is detection over metadata sampled at two instants, not proof of immutability | criterion 7's four mutations, each asserting **zero provider calls**; §6.3a's rows 3 and 4 are what the read-back proves and what nothing here proves |
| Retryability as data | `RETRYABLE_ERROR_CODES` reproduces §11.3a's eight rows; a heuristic per call site is forbidden by §11.3 rule 1 | the table itself is asserted, not just used |
| Bounded backoff | `attempt_count` / `max_attempts` (default 3, §5.2.6) and `available_at = now + base · 2**(attempt_count-1)`; arithmetic pinned with explicit numbers | §13 7.1 criterion 9's "backoff arithmetic" |
| Absorbing state | `NEEDS_RECONCILIATION` has no edge to `SUCCEEDED` except one the sweep walks (§11.3 rule 3), and it **keeps `active_slot` set**, so an unreconciled subject cannot acquire a second live operation until a defined recovery or administrative act exists — SF-3, and 7.1 defines no such act | transition-table test plus class 5: the refusal, and the absence of any expiry-driven release |
| Crash windows | W1–W11 (§6.7) are *designed* here and *tested* where their tables exist; the ones 7.1 can test today are W1 (journal only), W2 (write started), W3 (write done, no row), W9b (quarantine-adopted, never deleted) — plus W11, which is a change window rather than a crash window and is 7.1's to prove because both passes are 7.1 code | injected-exception tests, one per window, asserting the state, the `active_slot` value and that nothing was deleted |
| Read-side idempotency | `open_stream()` + `verify_object()` never write; they may be repeated freely (§6.6) | a repeat call leaves journal and object untouched |

Concretely about the interrupted multi-block upload, because §3.6's sentence
promises more than this plan will ship: 7.1 implements `put_stream()` as a
streaming SDK upload with `overwrite=False` and **does not** journal a per-block
list or resume a staged upload. An interrupted large upload therefore lands in
`NEEDS_RECONCILIATION` and is resolved by the sweep's adopt-or-report rule (§7:
"the alternative is a lost blob that reports success"). What the provider leaves
behind for an unfinished staged blob is **not claimed in either direction** —
per AGENTS.md rule 5 it must be measured (emulator first, then a real account)
before any resume feature is designed. Departure **D-δ3**, item **P-3**.

**The extra source read is bought deliberately.** Hashing in pass 1 and
re-uploading in pass 2 means the local file is read twice and the provider is
read once, against the earlier draft's single local read. §10.2 states the cost
exactly: `2·t_source(B) + t_write(B) + t_read(B) + 2·hash(B)` — two local reads
of `B` bytes, one provider read, two SHA-256 passes, and no scratch. The
alternatives were considered and rejected here rather than in code: buffering
the file to reuse the digest breaks §3.6's bounded-memory rule (the buffered
bytes would have to stay resident for the whole upload, so the memory floor
becomes the object size — which is the same defect that made
`ContentHandle.sha256` impossible), and spooling it to scratch first adds a
disk dependency and an orphan directory to a phase whose honest state is "no
scratch consumer" — and it still would not tell you the source didn't change,
which is the thing W11 exists to detect. Two sequential 1 MiB chunked passes is
therefore the cheapest mechanism that keeps both the memory bound and the
change detection, and it is why `ContentHandle` has no `sha256`: the digest
exists before the handle, not inside it. Evidence upload does **not** pay the
double read, because its pass 1 folds into the multipart→spool write (§6.3's
closing note, §16.9) — one disk write plus one disk read either way.

**Two kinds of guarantee, and which is which (§6.3a).** The mechanism above
produces one cryptographic claim and one detection claim, and the plan keeps
them separate because they fail differently:

| Claim | Source | If it is fooled |
| --- | --- | --- |
| The container holds exactly the bytes whose digest is recorded | pass 3 — an independent read of the provider's bytes, re-hashed and compared | it cannot be fooled silently: mismatch ⇒ `checksum_mismatch`, `FAILED_TERMINAL`, object `QUARANTINED`, never `AVAILABLE` |
| The key names the content it stores | key derivation from a completed `HashResult`, with no path from a partial digest | structurally impossible in 7.1's code, which is what criterion 8's test checks |
| Pass 1 and pass 2 read the same version of the file | the fingerprint comparison at the reopen | a rewrite that restores `size`, `mtime_ns` and the inode slips past pass 2's check — and is then caught by the row above, because the uploaded bytes no longer match the pass-1 digest. The price of being fooled is a wasted provider write and a quarantined blob |
| The source was unchanged *while pass 1 read it* | nothing in this design | **not established.** A change that starts and finishes inside the first read yields a digest of a blend, and read-back cannot see it — the provider faithfully stored what it was given. Drift detection (§6.8, D-13) and the sweep (§6.9) are the mechanisms that surface it, at the next scan or archive attempt |

No 7.1 test, docstring or handoff line may therefore describe a matching
fingerprint as proof that the source was immutable; §13's criteria 4, 5 and 7
word it as detection, and the fail-closed half is §6.3a's four-row table — abort
between the passes with zero provider calls, refuse `AVAILABLE` on any
disagreement, record both digests, and never retry against a second digest.

## P8. Area 7 — Institutional versioning and evidence ownership

Nothing versioned exists in 7.1: `archive_items` keeps its seven placeholder
columns (`models.py:385-403`) and `compliance_evidence` has no table. What 7.1
does is make the later version chain *possible without a second key scheme*:

| Later requirement | The 7.1 decision that supports it |
| --- | --- |
| D-13's "new version = new object, new row, never a replace" (§6.8b) | `evidence_key()` includes the `/v{version}/` segment (§6.1); an archive version gets a fresh content hash ⇒ a fresh key, structurally |
| "no blob is ever overwritten" (I-11) | `put_stream(..., overwrite=False)` is the only call form 7.1 exports, and the base signature keeps the flag explicit rather than defaulting to replace |
| One object, many references (§4.5) | `stored_objects.UNIQUE (object_key)` + the dedup lookup index `(institution_id, checksum_sha256)` ship in `0015` |
| Evidence ↔ domain associations (8 subject kinds, §5.2.4) | untouched — `evidence_associations` is 7.3's `0018_evidence` |
| Cross-institution dedup refusal | structural: the key embeds `institution_id` (§6.1's third property row); D-4 stays open |
| `correlation_id` linking a version to the operation that made it | the journal carries `correlation_id` and `subject_type/subject_id` in `AuditEvent`'s existing shape (`models.py:433-435`) |

## P9. Area 8 — Retention and legal-hold enforcement at destructive operations

7.1 performs no destructive operation, so it enforces no hold — and it must not
grow a private notion of "held" while pretending to be safe. The single rule for
7.1's code is: **`retention.py` stays the only definition of a hold**
(`count_active_holds_for_asset`, `backend/app/services/retention.py:320-329`), and nothing in
`content_access/`, `journal.py` or `verify.py` imports it. A test asserts that
import boundary, because the cheap failure mode is a future helper in `journal.py`
that copies the query.

The checklist 7.2–7.5 inherit, with the exact existing code each must call:

| Operation | Hold rule | Also required | Phase |
| --- | --- | --- | --- |
| Create an archive / a new version | allowed — preservation is pro-hold (§7.2) | `archive:write` + row scope | 7.2 |
| Retire an archive item | `409 hold_conflict:` from the existing helper (`retention.py:1211` style) | `archive:write`; `object_in_use` check | 7.2 |
| Withdraw evidence | allowed as a state change; reason mandatory | `evidence:write` | 7.3 |
| Delete evidence content | blocked; no route exists at all (§6.5 row 1) | — | none planned |
| Serve content for a held asset | allowed only through an approved grant with `purpose='legal'` or `'audit_response'` (§7.2's last row) | `retrieval:decide`, never self-approval | 7.4 |
| A sweep finding an orphan or a mismatch | **adopts or quarantines, never deletes** (§16.8 item 1) | `storage:manage` | 7.5 |
| Any policy, assessment or recommendation reaching `delete()` | impossible by design; nothing executes retention (§7.1) | — | never |

## P10. Area 9 — Audit coverage and the separate database-level protection

7.1 emits **no new audit events**: `AuditEvent` keeps its schema (`models.py:426-444`)
and `record_event` its one helper (`audit.py:16-30`, `commit=False` for the
atomic-in-transaction case 7.2 will need). The audit names the refinement created
(`evidence.delivery_deferred`, `evidence.delivery_denied`, `archive.content_read`,
§4.7) land with the routes that produce them (7.2, 7.4).

What 7.1 does contribute is the *correlation* half of auditability, which is much
harder to add afterwards:

- every journal row carries `correlation_id`, and §5.2.6 requires the same value
  in blob metadata; `put_stream()` therefore accepts metadata and the 7.2 caller
  passes `{provider, correlation-id, created-by, schema=datadiet-archive-v1}` —
  never an unfiltered client string (§6.3 step 5);
- `assert_no_secrets(payload)` (§6.2) is created in 7.1 as the one choke point,
  because `journal.detail` and blob metadata both need it before 7.2 writes real
  values; it reuses the redaction already proven in `_safe_message`
  (`azure_blob.py:58`) and its tests (`test_storage_provider.py:516-534`);
- `stored_objects.verify_error` and `storage_operations.error_message` are
  path-free and ≤2000 chars, the same limit §5.2.1 takes from `ScanError`
  (`scan.py:617`) — asserted by a test that writes a long message and reads back
  a truncated, path-free string.

The database-level append-only requirement is **not code** and stays what §7.8
and §16.11 say it is: OR-1…OR-6, executed in `infra/` as role grants (no
`UPDATE`/`DELETE` on `audit_events` for the app role, a separate retention role),
tracked as **D-11**, and *provably not satisfied* by anything in this plan. The
honest statement for the handoff report is: application-side discipline only; an
operator with database write access can still rewrite history until D-11 runs.

## P11. Area 10 — PostgreSQL test strategy and Floci integration

| Layer | What runs | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Default suite | temp-file SQLite built by `Base.metadata.create_all` (`conftest.py:34-51`) | gates, key derivation, journal machine, `CHECK` + composite `UNIQUE` refusals, streaming bounds with a fake provider, the four between-pass mutations | real row-level locking — SQLite emits nothing for `.with_for_update()` (§5.2.6a), so criterion 6's row-lock half is skipped here **with a printed reason**, not silently |
| PostgreSQL | `pgserver` inside `test_migrations_postgresql.py` | `0015`/`0016` apply; one head; `compare_metadata` reports zero drift against the models; `uq_operation_active_per_subject` + the `CHECK` actually refuse a live duplicate; **criterion 6's two-session barrier test runs for real**, including `FOR UPDATE`; the documented stamp-then-upgrade path still reaches head | throughput, latency, real Azure semantics |
| MySQL | existing dialect suite (`test_migrations_mysql.py`) **plus criterion 6's two-session barrier test, which must genuinely execute here** | the same two revisions apply and reach the new head; the **identical, branch-free** DDL is accepted by MySQL 8.4; constraint presence asserted by name on both server-backed dialects (§13 7.1 criterion 9); SF-1…SF-6 enforced under a real server with two sessions released by a barrier. This run needs `MIGRATION_TEST_DB_URL` + `MIGRATION_TEST_ALLOW_DROP` + `MIGRATION_TEST_EXPECTED_TESTS` (`ci.yml:76-96`), and the expected count is re-measured from the real inventory, never adjusted by weakening or skipping an existing test (P-10) | **nothing, locally.** The gated suite does not run without the env var, so a green `check.ps1` on this machine says nothing about MySQL enforcement — SQLite honours no `FOR UPDATE` and PostgreSQL never had the discarded-predicate problem. Enforcing `CHECK` since 8.0.16, discarding `CREATE INDEX … WHERE`, and treating `NULL`s in a unique index as distinct are **documented MySQL properties** until that CI run exists |

**The five-field MySQL evidence rule at handoff** (§15.5's execution rule, P20's
closing paragraph) — copied from the CI output rather than
paraphrased: the workflow and job name with the run or commit identifier; the
dialect and server version (`mysql:8.4`, `ci.yml:32-47`); the test node id of
the barrier test; the pass/fail/skip counts the guard compared against the
re-measured expected number; and whether the step ran at all. If the job is
unavailable, errored, or the test skipped, the handoff states criterion 6 as
**not verified on MySQL** and SF-1…SF-6 as proved on PostgreSQL and SQLite only
— the configuration's existence is not evidence, and "the suite covers MySQL" is
a sentence this plan prohibits.
| Floci emulator | opt-in, `FLOCI_STORAGE_TEST=1` (`test_storage_floci_integration.py:42`), loopback-guarded (`:76`) | `put_stream`/`open_stream`/read-back work **functionally** over the wire, including a mismatch injected by writing different bytes | **nothing about authentication** |

The emulator's fidelity limits are stated in §6.10 and ADR-0026
(`docs/decisions.md:320`) and are re-listed here because 7.1 is the phase that
adds the most emulator-touching code: unsigned and forged `SharedKey` requests are
accepted, including writes; the endpoint must be loopback; persistence is
`hybrid`, so an object's survival across a restart is not guaranteed. Therefore
every §6.10 control in 7.1 is application-side, a passing emulator run is reported
as **functional** evidence and never as authorization evidence, and no 7.1 test
asserts that a bad key was refused by the provider.

## P12. Area 11 — Malware scanning boundary and unscanned content

7.1 creates **no** scanner and no `ContentScanner` seam file: with no upload route
there is nothing to scan, and a `DisabledScanner` with no caller is the kind of
half-implementation the brief's constraints argue against. What 7.1 does:

- G10 cross-checks declared versus detected media and refuses the executable
  deny-list (§3.4, §3.7a rule 2) — and the module docstring says plainly that
  this proves shape, not safety, mirroring §3.7's "MIME validation is not a
  safety boundary" paragraph;
- `ContentHandle` carries **no** `scanned` field and **no** `sha256` field, so
  7.2/7.3 must add the always-`false` disclosure at their own response models
  rather than inheriting a silent default (§16.13's table, §9.5), and must read
  `HashResult.sha256` rather than assume the handle already knows (§3.2);
- the spool placement decision (§16.13: after the spool write, before the
  container write) is recorded here so 7.3 does not re-litigate it, and the reason
  it cannot move after `put_stream` is D-14 + T-12: a post-write refusal would
  need a delete.

## P13. Area 12 — Upload size, media type, timeout, concurrency and temporary storage

`ContentAccessLimits` (frozen dataclass, built once from settings by
`get_content_accessor`) is the single place ceilings live, so gates never read
`Settings` themselves and the parity test can construct limits directly:

| Limit | Source of the value | 7.1 behaviour | Unresolved |
| --- | --- | --- | --- |
| `archive_max_object_bytes` | §3.7a row 1, D-17 | G9 refuses when it is not configured (see the proposal below) | **D-17** |
| `evidence_max_upload_bytes` | §3.7a row 2, D-17 | not consulted in 7.1 (no upload path) | **D-17** |
| `evidence_allowed_media_types` | §3.7a row 3 | G10's deny-list is hand-written (~15 signatures) per D-2's default; exact match only, never a prefix (`application/*` admits every packed executable, §3.7a rule 2) | D-2 (dependency vs hand table) |
| `archive_verify_before_serve_bytes` | §3.7a row 6 | **not read by any 7.1 module.** Rule A is a 7.4 decision and rule E never consults it (§6.4, I-3) | D-17 (archive side only), D-25 |
| `azure_storage_timeout_seconds` | [EXISTING] `config.py:149`, `Field(default=30, ge=1, le=300)` | already applies per provider request; the SDK receives it exactly as `put`/`get` do today | — |
| Concurrency | no worker, no queue (§10.3) | in-request synchronous streaming; single-flight per subject (P7) | — |
| Temporary storage | §3.7a rows 4–5, OR-8 | **none.** 7.1 creates no spool, no scratch file, and no `evidence_upload_spool_dir`; the read-back and delivery paths are stream-only, so "scratch is upload-only" (§10.1 condition 4) holds from the start | **D-27** (provisioning), 7.3 |
| Chunk size | §3.6 | one constant, `_DEFAULT_CHUNK_BYTES = 1 MiB`, used by local read, `put_stream`, `open_stream`, verify | — |

**Proposal for the two byte ceilings (item P-4).** §3.7a's shape column says
`Field(default=<D-17>, ge=1)`, which requires a number this plan is not allowed to
invent. The alternative that keeps 7.1 unblocked *and* fail-closed is the pattern
the repository already uses twice: `local_source_roots` is empty by default and
every consumer refuses (`config.py:79`, `scan.py:114-121`), and
`evidence_upload_spool_dir` is documented as "empty ⇒ spool disabled ⇒ uploads
fail closed" (§3.7a row 4). So: `archive_max_object_bytes: int = Field(default=0,
ge=0)` where **0 means "not configured" and G9 refuses with
`content_unavailable:ceiling_unconfigured`**, and the same for
`evidence_max_upload_bytes` in 7.3. D-17 then supplies a number with no code
change, no invented limit, and no window in which an unconfigured deployment
streams something it should not. The cost of honesty is a documented refusal
rather than a working archive, which is correct for an unconfigured ceiling.

## P14. Area 13 — Frontend work

**7.1 changes zero frontend files.** `git status --porcelain frontend` must be
empty in the handoff. The frontend work the brief asks about is real and is
assigned here so nothing is discovered late:

| Work item | Phase | Grounding |
| --- | --- | --- |
| Upload with progress, cancellation and `413`/`415`/`503` validation errors | 7.3 (submit) + 7.6 (page) | `client.ts` has only `apiGet` (`:115`), `apiPost` (`:172`), `apiPatch` (`:177`) — a `FormData` + `XMLHttpRequest`-or-`fetch`-with-progress helper is genuinely new (§1.3 item 5) |
| Constraints fetched before the file picker opens | 7.3 | §8.2 row 26; §3.7a rule 4; no ceiling in any `VITE_*` (I-10) |
| Retrieval status incl. `deferred`, `denied_by_policy`, `expired` | 7.4 (data) + 7.6 (UI) | `Tone` already has `caution` (`semantic.ts:34`), which §9.2 requires for `deferred` — a deferral is neither a spinner nor a rejection |
| Integrity marker surfaced (`verified` / `unverified` / `not-applicable`) | 7.4 + 7.6 | §8.4a's per-route table; the archive-only `unverified` badge is the one §9.5 demands |
| Version-chain list | 7.6 | §8.2 row 27 exists because of D-13 |
| Types (`ArchiveItem`, `Evidence`, `RetrievalRequest`, `IntegrityStatus`) | 7.3–7.6, each with its route | `api/types.ts` (833 lines) has none of them today |
| Navigation and routes | 7.6 | `nav.ts:123-144` already groups `/archive` and `/retrieval`; `App.tsx:93-94` renders the two placeholders (`pages/Archive.tsx:8`, `pages/RetrievalRequests.tsx:8`, both `plannedPhase="Phase 3"`). §7.4a's nav point stands: gate on `archive:read`, which is invisible to non-admins until D-28 |
| Accessibility | 7.6 | the Phase 4/5 shell already fixes the landmarks and `aria-current` conventions (ADR-0024); new pages follow them rather than inventing patterns |
| Malware disclosure | 7.3 + 7.6 | "No malware scanning is performed." plus `scanned: false` (§9.5, §16.13) |

## P15. Area 14 — Dependencies, environment variables, configuration

| Item | Change in 7.1 | Notes |
| --- | --- | --- |
| `python-multipart` | **none** | 7.3's approval request (§16.7); nothing in 7.1 imports it, and `find_spec("multipart")` stays `None` (§1.3 item 6) |
| `azure-storage-blob` | already present (`requirements.txt`, pinned `>=12.31,<13`) | imported lazily (`__init__.py:70-72`); the `STORAGE_PROVIDER=none` import test is extended, not replaced |
| `pgserver` | already a dev requirement | used for `0015`/`0016` on a real server |
| Any other package | none | including no `python-magic` (D-2's default is the hand table) |
| `STORAGE_PROVIDER` | unchanged; default `none` (`config.py:139`) | 7.1's modules are importable and testable with it set to `none`, because `build_object_store` is still never called from application code |
| `EVIDENCE_UPLOAD_SPOOL_DIR`, `EVIDENCE_UPLOAD_SPOOL_MAX_BYTES` | not added (P13) | 7.3, with D-27 |
| `ARCHIVE_MAX_OBJECT_BYTES`, `EVIDENCE_MAX_UPLOAD_BYTES` | only with P-4 | documented in `.env.example` beside the storage block (`.env.example:114-168`) |
| `EVIDENCE_ALLOWED_MEDIA_TYPES` | not added in 7.1 | G10 uses the deny-list constant; the allow-list belongs to 7.3's upload path (§3.7a row 3) |
| `ARCHIVE_VERIFY_BEFORE_SERVE_BYTES` | not added | 7.4, rule A only |
| `STORAGE_SWEEP_MAX_OBJECTS`, `INTEGRITY_REVERIFY_AFTER_DAYS` | not added | 7.5 (§6.9, OR-9) |
| `VITE_*` | none, ever | I-10, §6.10 |
| Deployment settings, `infra/`, Render, Floci config | none | "Do not touch Floci infrastructure or its data" |

## P16. Area 15 — Test coverage matrix

Every scenario the brief lists, with the phase that can honestly test it and
7.1's contribution:

| # | Scenario | Where it is actually testable | 7.1's part |
| --- | --- | --- | --- |
| 1 | Authorization (403 + `authorization.denied`) | 7.2+ routes (`require_permission`, `auth.py:595`; `_audit_denied_write`, `:625`) | test that no 7.1 module imports `auth` and that no permission name exists yet (P4) |
| 2 | Cross-institution isolation (404, not 403) | 7.2 routes, via `resolve_institution_scope` (`auth.py:671`) | `derive_object_key` embeds `institution_id`; a test proves two tenants' keys differ for identical content |
| 3 | Duplicate uploads / dedup | 7.3 (`POST /evidence`), 7.2 (`409 already_archived`) | `UNIQUE (object_key)` + the dedup index ship in `0015`; `overwrite=False` semantics tested (P7) |
| 4 | Interrupted uploads (W9) | 7.3 (spool + client disconnect) | not applicable to 7.1 — **no spool exists**; the journal's `FAILED_TERMINAL, error_code='aborted_upload'` row is nonetheless defined in `RETRYABLE_ERROR_CODES` |
| 5 | Orphaned blobs | 7.5 (sweep adopts) | W2/W3 tests assert `NEEDS_RECONCILIATION` and that the object is **adopted, not deleted** |
| 6 | Checksum mismatch | 7.2 (ingest), 7.4 (rule E) | `verify_object` returns `mismatch`; §13 7.1 criterion 5's fake-provider test with both hashes recorded and `FAILED_TERMINAL` — never `SUCCEEDED`, and never `AVAILABLE` |
| 7 | Concurrent operations | **7.1** (two sessions, no route needed) | criterion 6's barrier test — class 2: one row, one provider write, loser refused by `IntegrityError` at the insert — plus criterion 9's completed-coexistence case; the source mutated between passes is criterion 7's W11 half (P5.2, §5.2.6a) |
| 8 | Versioning | 7.2 (D-13 chain), 7.3 (supersession) | `evidence_key()` carries `v{version}`; no key is ever reused for different bytes |
| 9 | Legal holds | 7.2 (`/retire` → `409 hold_conflict:`) | import-boundary test: `retention.py:320-329` stays the only definition of "held" |
| 10 | Retention | 7.2 (`assessment_id`/`decision_id` provenance) | none; `0015`/`0016` reference neither, and nothing executes retention (§7.1) |
| 11 | Audit failures | 7.2+ (a denial inside a transaction that must not half-write) | `assert_no_secrets` + path-free/≤2000-char message tests (P10) |
| 12 | Gates G0–G10 | **7.1** | §13 7.1 criterion 2, fixtures outside the repo, Windows junction skipped with a printed reason |
| 13 | Streaming memory bound | **7.1** | 512 MiB synthetic file through a 1 MiB pipeline with an allocation probe, **run separately on pass 1 (`hash_source`) and pass 2 (`reopen`)**, plus criterion 4's third assertion that pass 1 retains nothing — iterator, never a large `bytes` |
| 14 | Migration applies on PostgreSQL and MySQL | **7.1** | `pgserver` + the MySQL suite, both to the new head, with the `CHECK` + composite `UNIQUE` asserted present on both dialects (criterion 9) |
| 15 | Default app never imports the storage SDK | **7.1** | `test_storage_provider.py:567` extended to the four new modules (criterion 10) |
| 16 | Content-boundary ordering: digest → key → upload → read-back → permanence | **7.1** | criterion 5's third test (key derived from the pass-1 digest), criterion 8 (no key from a partial digest), criterion 7 (W11 refuses with zero provider calls) |
| 17 | Reservation lifecycle: atomic release, rollback leaves no orphan, absorbing state keeps the subject occupied | **7.1** (direct database tests, no route needed) | classes 3, 4 and 5 of §5.2.6a — see P5.2's mapping to files. SF-2, SF-3, SF-4, SF-5; a handoff without all three classes has not proved the invariant it reports |
| 18 | The fingerprint is detection, not proof of immutability | **7.1**, as negative space | §6.3a's attribution table is asserted by criterion 5's read-back tests and criterion 7's mutations; no test in 7.1 is worded as though a matching `SourceFingerprint` established that the source was never modified, and the blended-read case is documented as undetectable rather than tested into a false pass |

Two "never" assertions the brief requires, and how each is made enforceable
earlier than the phase that needs it:

| Never | Full version (later phase) | 7.1's version |
| --- | --- | --- |
| The ceiling lookup must never be consulted on an evidence route | 7.4: a test with `archive_verify_before_serve_bytes` set tiny still returns `X-DataDiet-Integrity: verified` for evidence (§13 7.4 criterion 4; threat T-20) | `verify.py` and `content_access/` import no `Settings` and read no ceiling: a static test over the module sources plus `ContentAccessLimits` having no `verify_before_serve_bytes` field at all. Rule E's mechanism is born without the knob |
| No code path reachable from the sweep may call `delete()` | 7.5: the sweep's tests + a call-graph assertion | `delete()` (`base.py:141`) gains **zero** call sites in 7.1; a test asserts the count outside `services/storage/` is still what it is today, so the regression can be attributed to the phase that added one |

Baseline to stay green, as recorded rather than as assumed:
`scripts/check.ps1` exits 0 with "All checks passed." — backend Ruff,
operator-script Ruff, pytest **340 passed / 20 skipped** (the 20 being the 19
live-MySQL migration tests plus one Windows-symlink-dependent test), frontend
TypeScript, Vitest **507 tests in 32 files**, and a production build
(`docs/production-readiness.md:15-19`, re-run 2026-11-04). ADR-0026 then records
**386 passed / 35 skipped** after the Phase 6.x storage additions
(`docs/decisions.md:326`), so the two documented numbers differ by exactly the
61 provider tests that are present-but-uncommitted; the plan's own claim is
about the *delta*, not the absolute. Therefore 7.1's handoff states the
re-measured numbers from the first `check.ps1` run of the implementation
session, and the frontend count must be **identical** to whatever that run
reports, which is itself evidence that no frontend file changed.

## P17. State-transition tables

`storage_operations` (the only machine 7.1 implements, §11.3) as
`journal.VALID_TRANSITIONS`, mirroring the structure — not the names — of
`scan.VALID_TRANSITIONS` (`scan.py:65-72`), which is resolved D-10's "copy the
shape" rule (I-12, ADR-0040):

| From | Allowed to | Cause | `active_slot` written |
| --- | --- | --- | --- |
| `PENDING` | `RUNNING`, `ABANDONED` | claim; operator withdrawal | `1` → `1`, or `1` → `NULL` |
| `RUNNING` | `VERIFYING`, `RETRY_WAIT`, `NEEDS_RECONCILIATION` | write done; retryable provider failure; ambiguous side effect | `1` (all three are protected) |
| `VERIFYING` | `SUCCEEDED`, `FAILED_TERMINAL`, `RETRY_WAIT`, `NEEDS_RECONCILIATION` | hash ok; hashes disagree (§6.3 step 11); a failed read is retryable even when the write is not (§11.3's `VERIFYING` row); verdict unobtainable | `1` → `NULL` for the two terminal targets, `1` for the other two |
| `RETRY_WAIT` | `RUNNING`, `FAILED` | backoff elapsed with budget left; budget exhausted | `1`, then `1` or `NULL` |
| `NEEDS_RECONCILIATION` | `SUCCEEDED`, `RUNNING`, `FAILED_TERMINAL` | **only** the sweep's proofs (7.5) — absorbing with respect to every automatic path, which §11.3 rule 3 requires | `1` until the sweep's own transaction terminates it; **an unreconciled subject therefore stays occupied** |
| `SUCCEEDED`, `FAILED`, `FAILED_TERMINAL`, `ABANDONED` | ∅ | terminal | `NULL`, always |

Two properties of that column, because they are the part a reviewer can check
without running anything: §11.3 rule 4 makes every edge a *two*-column `UPDATE`,
so `journal.transition()` is the only function allowed to write `state`, and it
writes `active_slot` in the same statement — the `CHECK` of §5.2.6a then turns a
transition that forgets the gate into a database error rather than a latent bug,
which is exactly what criterion 7's four one-sided combinations test. And the
row that matters operationally is `NEEDS_RECONCILIATION`: it keeps the slot, so
"the sweep will sort it out" is not also "a second operation may start meanwhile"
— a subject with an unresolved outcome is refused a new live operation with the
same `409 operation_in_progress` (§11.3a's concurrent-intent row).

Read as invariants rather than as a column, that table is SF-1 and SF-2 (§5.2.6a)
stated as edges: the five protected states all write `1`, the four terminal
states all write `NULL`, and no edge writes one without the other (SF-4). SF-5 is
what the table cannot show and the tests can: because the gate is a column of
this row, a transaction that rolls back removes the operation and the
reservation as one object, so no orphan survives the failure — the assertion
class 3 makes, in three ways, and the reason 7.1 introduces no reservations
table to "make cleanup explicit".

`stored_objects.state` (§6.8, §11.1 — seven states; the machine is *declared* in
7.1 only insofar as `0015` defaults `state` to `PENDING_WRITE` and §11.1's entry
rule constrains 7.2): `PENDING_WRITE → AVAILABLE | FAILED | QUARANTINED`;
`AVAILABLE → QUARANTINED | MISSING | DELETE_PENDING`; `QUARANTINED → AVAILABLE |
DELETE_PENDING`; `MISSING → AVAILABLE`; `DELETE_PENDING → DELETED` (terminal).
The two D-12 constraints that code must enforce: no edge into `AVAILABLE`
without a completed read-back, and `QUARANTINED → AVAILABLE` only via an explicit
`integrity_verify` operation — never as a side effect of a read, and never at all
from a pass that could not complete.

`retrieval_requests.status` (§11.2 — **not** touched in 7.1; recorded so 7.4's
`0019_retrieval_requests` CHECK is written from one source): `pending → approved |
rejected | cancelled`; `approved → delivered | deferred | denied_by_policy |
expired`; `deferred → delivered | denied_by_policy | expired`; `delivered →
expired`; `denied_by_policy → expired`. Terminal `rejected`, `cancelled`,
`expired`; `delivered` is not terminal because the window may still be open;
`deferred` is reached only when rule E's pass could not complete, and
"`deferred` + window keeps running" is D-29's documented default (§7.6 rule 4).

## P18. Risks and unresolved decisions

Departures from the architecture document. Seven now, and they are not
equally open: D-δ2 was approved as **P-1**, and D-δ5/D-δ6/D-δ7 are the review's
own mandated corrections written into §5.2.6a, §3.2/§6.3 and §14.1; D-δ1, D-δ3
and D-δ4 remain approval items (P19).

| ID | Departure | Reason | If refused |
| --- | --- | --- | --- |
| D-δ1 | adds `ContentMediaRejectedError` to §3.2's four | G10's refusal is not a path refusal; the UI and §8.4's `content_media_rejected` need their own class | G10 collapses into `ContentPathRejectedError` and the UI mis-explains a media refusal |
| D-δ2 | renumbers the six revisions so chain order = phase order (§13's original `0015`+`0019` for 7.1 is not a single-head chain) | §15.2's own list was non-monotonic; a branch would fail `test_the_repository_has_exactly_one_head` | 7.1 must ship empty placeholder revisions, or a non-monotonic chain, or a branch — all three worse. **Approved as P-1 and already applied to §5.5/§13/§15.2** |
| D-δ3 | no block-list journalled resume for interrupted uploads | SDK behaviour on an interrupted staged blob is unmeasured; a claim about resuming would violate AGENTS.md rule 5 | 7.1 would need to state a guarantee it has not measured |
| D-δ4 | defers `content_access/upload.py` (`UploadScratch`) to 7.3 | no caller, therefore no honest test in 7.1 | 7.1 ships unexercised spool code |
| D-δ5 | **replaces** §5.2.6's partial unique index with the `active_slot` + `CHECK` + composite `UNIQUE` pair and the parent-row `FOR UPDATE` lock (§5.2.6a), and removes `active_operation_exists()` from the design | the superseded design was check-then-insert on MySQL, which is not atomic; a partial index is silently discarded there. Approved as the correction to refused P-6 | 7.1 has no MySQL-safe single-flight guarantee, and criterion 6 cannot pass — there is no acceptable "refused" here, only a weaker mechanism that the brief rejects |
| D-δ6 | `ContentHandle` loses its `sha256` field; ingestion becomes hash-then-reopen (three passes, two local reads) | a lazily-read handle cannot know a digest it has not yet computed; the alternative was buffering the whole file (§3.6 forbids it) or spooling to scratch (adds an availability dependency to archive ingest to avoid explaining a cost) | either a `ContentHandle.sha256` that is always `None`, or a memory bound that is the object size. Approved as correction 2 |
| D-δ7 | 7.1 accepts **no** ADR as *Accepted* at planning time; ADR-0027/0028/0040 move only in the handoff that reports their tests passing | the revised P-7 rule (§14.1): a plan is not an implementation | ADRs would claim decisions the repository cannot yet show — the defect correction 3 exists to remove |

Implementation risks, rated by what would go wrong rather than by feeling:

| ID | Risk | Mitigation in 7.1 |
| --- | --- | --- |
| R-1 | The single-flight guarantee degrades to "the code checked first", which on MySQL is not atomic: two sessions both pass an existence read and both insert | no existence read exists to pass (P3.2's third contract decision); the guarantee is the `UNIQUE` at insert plus the row lock, and criterion 6's barrier test is the thing that must pass before the handoff claims anything about concurrency |
| R-1b | The `CHECK` is trusted on MySQL from documentation alone while the local suite only exercises SQLite | stated as such in P5.2 and P11, and the refusal is named in the handoff sentence: enforced-and-proved on PostgreSQL + SQLite, enforced-by-identical-DDL and proved-in-CI on MySQL (`ci.yml:76-96`) |
| R-1c | Pass 2's re-read finds different bytes than pass 1 hashed, so the digest in the key and the digest of what was uploaded disagree in a way the design would not notice | `reopen()` compares the `SourceFingerprint` before yielding a byte and criterion 7's four mutations (grow / shrink / equal-length rewrite / inode swap) each assert **zero provider calls**; equal-length rewrite is the case that size+mtime alone cannot catch, which is why the fingerprint carries `st_ino` and `st_mtime_ns` |
| R-1d | A future caller "optimises" the two reads back into one by buffering the file or spooling it, silently trading the memory bound for I/O | forbidden in §3.6's rules and §3.2's prose, and pinned by criterion 4's third assertion (after `hash_source()` returns, no copy of the source exists anywhere) plus §15.4's promise row "no `sha256` field on `ContentHandle` returns" |
| R-2 | `put_stream` silently buffering into one `bytes` and defeating the whole memory story (§16.5) | the iterator assertion and the peak-RSS probe (§13 7.1 criterion 4) are both required, not optional |
| R-3 | Read-back becomes "trust what we wrote" (a `get` of local bytes) so a provider-side corruption is invisible | §13 7.1 criterion 5's second test proves the **fake's** read is actually called |
| R-4 | `content_access` quietly imports `auth` or `retention` and grows a second authorization/hold definition | named import-boundary tests; the `InventoryRecord`-not-id signature removes the easiest path to it |
| R-5 | Adding two tables changes `compare_metadata` expectations, so the drift test is weakened instead of updated | the drift test is updated in the same change and must still assert `diffs == []` (`test_migrations_postgresql.py:245`) |
| R-6 | A future phase treats 7.1's mechanism as policy and reads a ceiling inside `verify_object()` | the static no-`Settings` test plus §13 7.4 criterion 4's behavioural test are two independent locks (threat T-20) |
| R-7 | Numbers get invented under time pressure (D-17) | P13's fail-closed zero-default, or no settings at all if P-4 is refused; either way no ceiling ships with a fabricated value |
| R-8 | MySQL tests are added and CI's hard expected-count literal (`ci.yml:76`, `:85`) is left at 19, so the pipeline fails on a *success* — the easiest "fix" under pressure is to lower or delete the gate | P2.2 lists the two literals as an explicit edit with approval item P-10; the prohibition row in P2.3 forbids loosening the gate in any other direction, so weakening it is a visible diff rather than an accident |
| R-9 | The two-session concurrency test is written as one session that queries twice, because that is easier and still green — the exact failure mode the review named when it refused P-6 | criterion 6's own wording is the acceptance test for the test: it must use two `Session` objects, a `threading.Barrier`, and assert the loser **inserted nothing**; "a test that only re-reads the winning row does not satisfy this criterion" is quoted in P16's row 7 so the reviewer can compare, not infer |

Open decisions relevant to 7.1 and its immediate neighbours, with what each
actually blocks: **D-2** (hand signature table is the default, so nothing blocks),
**D-17** (blocks 7.2's G9 unless P-4 is approved), **D-26** (the `scan.py`
extraction — 7.1 is precisely the phase where refusing it is cheapest), **D-27**
(spool provisioning, 7.3), **D-28** (role widening, 7.6 demoability), **D-29**
(deferral window, 7.4 — documented default, so not a blocker), **D-30** (the
same MySQL-discards-partial-index gap that 7.1's redesign removed from
`storage_operations` still applies to `uq_archive_current_uid` in §5.2.2 and
`uq_evidence_current` in §5.2.3 — both are 7.2/7.3 tables, so 7.1 neither ships
nor silently fixes them; the §5.2.6a mechanism is the candidate answer, and the
gap is registered rather than assumed away), and **D-11**
(OR-1…OR-6 infra, unsatisfiable by code). None of them blocks 7.1 itself; that is
§16.16's claim and this plan found no exception to it.

## P19. Items requiring approval before implementation

Status is recorded as of this revision pass, so the register separates what is
already decided from what still needs a decision. Nothing in the *Approved /
closed* rows needs re-approval; the two *redesigned* rows do, because the
mechanism changed, and the *new* rows are introduced by this pass.

| ID | Status | What is being asked | Recommended | Blocks |
| --- | --- | --- | --- | --- |
| **P-1** | **Approved — closed** | The linear renumbering (D-δ2). §5.5, §13 and §15.2 now carry `0015`–`0020` in chain order, the head was re-verified (14 files, one head, `0014_external_identities`), and `0016` is now branch-free because §5.2.6a removed the partial index | — | nothing; the standing condition moved to P-1a |
| **P-1a** | **new, open** | Confirm the standing rule, not a number: re-run `alembic heads` immediately before writing `0015`, and if an unrelated revision has taken the number, re-label the table in P5.1 rather than branching — the chain shape, not the digits, is the decision | confirm | 7.1's first migration file |
| **P-2** | **Approved — closed** | Defer `content_access/upload.py` to 7.3 (D-δ4) | — | nothing; scope only |
| **P-3** | **Approved — closed, with its condition standing** | `put_stream` ships **without** block-level resumability (D-δ3); the interrupted-staged-upload measurement (emulator, then a real account) is a precondition on ever designing resume, not on 7.1 | schedule the measurement | nothing in 7.1; a later phase's claim |
| **P-4** | **Approved — closed** | Fail-closed zero-default ceilings: `archive_max_object_bytes` / `evidence_max_upload_bytes` default `0` = "not configured" and G9 refuses with `content_unavailable:ceiling_unconfigured` | — | now in scope: P2.2's `config.py` and `.env.example` rows are approved edits, no longer conditional |
| **P-5** | **Approved — closed** | 7.1 adds **no** permission names; P4's table registers them phase-by-phase from 7.2 | — | nothing |
| **P-6′** | **Redesigned — needs approval as the replacement** | The refused P-6 (partial unique on PG/SQLite + `active_operation_exists()` on MySQL) is **withdrawn**. In its place, §5.2.6a: layer 1 `lock_operation_subject()` takes `SELECT … FOR UPDATE` on the parent `inventory_records` row inside the transaction, and layer 2 adds `active_slot` with a `CHECK` binding it to the protected state set plus a plain composite `UNIQUE (operation_kind, subject_type, subject_id, active_slot)`. Identical DDL on all three dialects, no dialect branch, and no existence-check-then-insert anywhere. The clarification pass then made the contract explicit as **SF-1…SF-6** (§5.2.6a, restated with 7.1's obligations in P5.2) and enumerated the **five test classes** that prove it — constraint combinations, two-session concurrency, rollback leaving no orphan, atomic terminal release, and absorbing-state occupancy. Approving P-6′ is approving that six-invariant contract, not only the DDL | approve the replacement | 7.1's journal design, `0016`'s DDL, `models.py`, and criteria 6, 7 and 9's tests |
| **P-6a** | **new, open, consequence of P-6′** | Confirm the two things the replacement costs: (a) the extra column is `active_slot` (`Integer` nullable, carries no meaning — it is a constraint anchor), and (b) `integrity_verify` / `reconcile_sweep` operations lock their own kind's parent or take no lock at all (§5.2.6a's stated exception), because there is no single subject row to lock for a platform-wide sweep | confirm | nothing further; it is scope honesty |
| **P-7′** | **Modified — needs approval as rewritten** | The ADR rule is now §14.1's: an ADR becomes *Accepted* **only at the handoff that reports its code and passing tests**, never because a plan described it. For 7.1 the acceptable subset is **ADR-0027, ADR-0028, ADR-0040**; ADR-0030 and ADR-0037 stay *Proposed* until 7.2, and the rest until their own phases. `docs/architecture.md` gains the corrected status wording (criterion 11), **not** "no route, no table, no consumer" | approve as rewritten | AGENTS.md definition-of-done item 5, and the two `docs/` rows in P2.2 |
| **P-8** | **Approved — closed** | D-11's audit-protection grants stay out of 7.1; application discipline only, honestly reported | — | no overclaim |
| **P-9** | **Approved — executed in this pass** | The two documentation defects: §3.9's `archive:write` reference now points at §7.4, and the §7.2a hold table names `archive:write` / `evidence:write` while stating that `evidence:withdraw` / `archive:retire` "does not exist and is not proposed". **No ninth permission name was invented** — P4's eight are unchanged and `auth.py` is still untouched | — | nothing; closed unless you want different wording |
| **P-10** | **new, open** | Approve the one CI edit: `MIGRATION_TEST_EXPECTED_TESTS` and its step name (`ci.yml:76`, `:85`) change from `19` to the re-measured count after 7.1's MySQL tests exist. The alternative — leaving it — fails CI on a passing suite. Two rules now bound that edit (P2.2, P11): the number reflects the **real test inventory**, and bringing it into agreement is never allowed to happen by weakening, skipping, xfail-ing or deleting an existing MySQL test | approve the principle; the number is measured, never guessed | 7.1's MySQL tests cannot merge without it |
| **P-11** | **new, open (cost acceptance, not a design choice)** | Confirm that the corrected ingestion ordering is accepted **with its cost**: two local source reads and one provider read per archive object (§10.2's `2·t_source(B) + t_write(B) + t_read(B) + 2·hash(B)`), no buffering, no scratch, and `ContentHandle` loses its `sha256` field (D-δ6). Refusing the cost does not make the double read disappear — the only alternatives are the memory bound or the change detection | confirm the trade | 7.1's `content_access` API shape |
| **P-12** | **new, open (handoff wording and MySQL evidence)** | Confirm the reporting rule for criterion 6, which the clarification pass turned into four statements (§15.5, P11): the barrier test **must actually execute** on MySQL in CI under `MIGRATION_TEST_DB_URL`; a locally green SQLite or PostgreSQL run is **not** MySQL evidence, and the reason is dialect-specific — SQLite honours no `FOR UPDATE`, PostgreSQL never had the discarded-predicate problem; the handoff carries the **five fields** from P11 (job and run, dialect and server version, test node id, the compared counts, whether the step ran); and if that job is unavailable, errors or skips, criterion 6 is reported **not verified on MySQL** rather than as covered by configuration. Locally the row-lock half is still skipped on SQLite with a printed reason. Three MySQL properties the design leans on remain documented rather than measured here (P5.2 lists which) | confirm the wording and the evidence rule | how 7.1 is reported, not what is built |
| **P-13** | **new, open** | Confirm that **D-30 stays open**: the identical MySQL-partial-index gap now applies only to `uq_archive_current_uid` (§5.2.2) and `uq_evidence_current` (§5.2.3), both 7.2/7.3 objects, so 7.1 registers the gap instead of redesigning tables it is not shipping | acknowledge; decide in the 7.2 plan | nothing in 7.1 |
| **P-14** | **new, open** | Confirm the scope of the two documentation passes: the 2026-11-06 revision and the 2026-11-07 clarification together touched **two documentation files**, no code, migration, test, CI, dependency, config or `.env` file, and nothing is staged. No ADR changed status and **D-30 remains open**. Implementation starts only on your explicit approval | confirm | everything |

The register is therefore **16 rows: 7 closed approvals, 2 rewritten designs
awaiting approval, and 7 new items** — and exactly two of the open rows change
what gets built (P-6′ and P-11); the rest change what gets measured, numbered or
reported.

Not asked for here, and deliberately so: `python-multipart` (7.3), any role
widening (D-28), any Floci or infra change, and any Git action — staging,
committing, pushing, branching, stashing and history editing remain yours.

## P20. Definition of done for 7.1

**The ADR rule first, because it gates the last row of the table.** §14.1's
revised rule: a `docs/decisions.md` ADR moves from *Proposed* to *Accepted* only
in the handoff that reports (a) the code the decision describes and (b) the
tests that check it, with the run's real numbers — planning, however detailed,
is not a decision having been taken. Writing it as an explicit gate keeps the
revised P-7 from being re-violated by an implementer who tidies docs at the
start of a session. For 7.1 the eligible subset is **ADR-0027** (the content
boundary and its three-operation contract), **ADR-0028** (streaming + read-back
and the ordering that follows from it) and **ADR-0040** (the dedicated
storage-operation machine, `active_slot` half included). **ADR-0030** (journal-first *writes*, which need a writer) and **ADR-0037**
(read-back from a real ingest call site) describe behaviour 7.1 cannot show, so
they stay *Proposed*; every other proposal keeps whatever §14.1's
earliest-honest-phase table already says, and this plan adds no exception to it. Highest accepted ADR remains ADR-0026
(`docs/decisions.md:320`) until 7.1's tests pass.

Eleven acceptance criteria from §13 7.1, each with the command or test that
evidences it:

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | A connector still cannot read content | `test_scan_never_ingests.py`, `test_content_access.py`; the recording fake asserts zero provider calls, zero journal rows and zero `content_access` opens after a real scan |
| 2 | Gates G0–G10 each refuse for their own reason | `test_content_access.py`, one test per gate, fixtures outside the repo; junction skipped with a printed reason |
| 3 | The D-1 parity test | `test_content_access.py`'s table-driven parity case over `None`, `""`, unknown key, present key, gone key — both readers agree, same error class |
| 4 | Streaming stays bounded **on each pass** | `test_storage_streaming.py`: 512 MiB synthetic file, 1 MiB chunks, allocation probe run separately for `hash_source()` and `reopen()`; iterator-not-`bytes` assertion; and the third assertion that pass 1 **retains nothing**, which is what forbids the buffer-to-avoid-the-second-read shortcut |
| 5 | Read-back is exercised, not present | mismatch ⇒ both hashes recorded and `FAILED_TERMINAL`/`checksum_mismatch`; second test proves the provider's read is called; third proves the key the provider received came from the pass-1 digest and that no object reaches `AVAILABLE` from a verification that did not read the provider |
| 6 | Single-flight proved with two real sessions, on MySQL included | `test_storage_single_flight.py`: two `Session` objects, `threading.Barrier`-released, one engine, same `(kind, subject_type, subject_id)`; asserts exactly one non-terminal row, exactly one provider write attempted, loser raises `IntegrityError` having inserted nothing, winner untouched — **plus class 3's three rollback cases, each ending at zero rows and zero reservations**. PostgreSQL via `pgserver`; **MySQL must actually execute** under `MIGRATION_TEST_DB_URL` (`ci.yml:76-96`) and the handoff must quote that job per P11's five-field evidence rule; SQLite runs the constraint half and prints why the lock half cannot run |
| 7 | Constraint + change-window tests | two things, now five tests: the `CHECK` refuses each of the four one-sided `state`/`active_slot` combinations (class 1) and each terminal transition is re-read in one snapshot with the gate `NULL`, while a state-only update raises the `CHECK` and leaves the row unchanged (class 4); and the four between-pass mutations (grown, shrunk, equal-length rewritten, inode-swapped-with-identical-size-and-mtime) fail with `content_changed` and **zero provider calls** recorded. §6.3a's wording is the guard against over-claiming what those mutations prove |
| 8 | Key derivation is safe by construction | `test_object_keys.py`: ≤1 024 chars with worst-case inputs, `validate_object_key` composition, no filename/path/backslash ever, and no key buildable from anything but a completed `HashResult` |
| 9 | The journal machine is a machine | `test_storage_journal.py` over every §11.3 row incl. backoff arithmetic and the composite `UNIQUE`'s completed-operation coexistence, **with class 4's atomic terminal release and class 5's `NEEDS_RECONCILIATION` occupancy — the absorbing state keeps `active_slot = 1` and no expiry, retry or restart frees the subject**; plus `0015`/`0016` applied on `pgserver` **and** MySQL with both constraint objects asserted present by name on each dialect |
| 10 | `STORAGE_PROVIDER=none` unchanged | `test_storage_provider.py:567` extended to the new modules, still asserting no SDK import |
| 11 | `docs/architecture.md` states exactly what was built | the status line names the content boundary, the streaming + read-back hooks, the journal and the two tables **with no application writer**, and denies any archive/evidence route or workflow consumer; the diff shows only ADR-0027/0028/0040 moved, each with its test-run pointer |

**The MySQL line in that table is a result, not a configuration.** Criterion 6
is satisfied on MySQL only by a run that executed: the handoff reproduces the
five fields from P11 — job and run identifier, dialect and server version, the
barrier test's node id, the counts the guard compared, and whether the step ran
at all — next to the `MIGRATION_TEST_EXPECTED_TESTS` value it had to match after
re-measurement (P-10). If the job did not run, failed, or the test skipped, the
report says **"criterion 6: not verified on MySQL"** and stops there; it does
not substitute the PostgreSQL or SQLite pass, because those two dialects are
exactly the ones where the MySQL-specific properties are not in play, and it
does not describe the test's presence in the file as coverage. Nor is the count
ever brought into agreement by weakening an existing test — that would turn the
one edit this phase is allowed to make in CI into the thing CI exists to catch.

Then, with real exit codes recorded in the handoff and **no** commit:
`.\scripts\check.ps1` (the same gate CI runs), the pytest and Vitest counts
against the P16 baseline, the gated MySQL run with its re-measured expected
count (P-10), `git status --porcelain` reproduced in full so every changed file
is visible, and the structure/citation checks over both documents.
The phase stops at that report and waits — including before 7.2, because
`0017_archive_items` and the first permission names belong to a different
approval.

## P21. Prohibitions carried forward

Each constraint from the brief, and where this plan honors it:

| Constraint | How 7.1 satisfies it |
| --- | --- |
| `ContentAccessor` separate from `SourceConnector` and `build_connector` | new package; zero edits to `scan.py` or `connectors/`; parity test instead of extraction (P2.1, P2.3) |
| Blob Storage private; no credentials, connection strings or unrestricted URLs to the browser | no route at all; `assert_no_secrets`; `_safe_message` reused; no `VITE_*` (P10, P15) |
| PostgreSQL authoritative for metadata and authorization | the two new tables are metadata; provider metadata (`etag`) stays correlation (§5.2.1) |
| Existing authentication and fail-closed authorization semantics preserved | `auth.py` untouched; scoping reused, never reimplemented (P3.3) |
| Do not widen existing role permissions | zero names, zero grants, and a test that proves it (P4) |
| No existing API contract changes outside approved scope | no route, schema, status code or response model changes (P3.1) |
| Historical migrations never rewritten; forward-only | `0001`–`0014` byte-identical; new revisions additive with honest `downgrade()` docstrings (P5.4) |
| No queue/broker unless demonstrated necessary | none added; the journal is the seam that would let one arrive later, and §10.3/§10.4 own the trigger list (P7, P13) |
| Preserve uncommitted Phase 6.x storage work | every storage edit is additive; no revert, no stash, no branch change (P2.2) |
| Floci infrastructure and data untouched | tests address the running emulator over loopback with env-supplied credentials only (P11) |
| Single-flight must be a database guarantee on MySQL, not a lookup followed by an insert; re-reading a winning row is not prevention | §5.2.6a's two layers (parent-row `FOR UPDATE` + `active_slot`/`CHECK`/composite `UNIQUE`), `active_operation_exists()` not written and not exported, and criterion 6 asserting the loser **inserted nothing** (P3.2, P5.2, P7, P16 row 7). The reservation now carries six named invariants, SF-1…SF-6, each with the test class that proves it, and the two layers are documented as complementary rather than interchangeable |
| The fingerprint is change detection, not a cryptographic snapshot or an immutability proof | §6.3a attributes every claim to the step that earns it: the provider read-back carries the integrity claim, the between-pass comparison carries only detection, and the blended-first-read case is written down as **not established** rather than glossed. No 7.1 test, docstring or handoff line may call a matching fingerprint proof that the source was untouched (P7's attribution table, P16 row 18) |
| MySQL verification is a CI result or it is nothing | the barrier test executes on MySQL under `MIGRATION_TEST_DB_URL`, the handoff quotes P11's five fields, a local SQLite/PostgreSQL pass is explicitly refused as MySQL evidence, an unavailable or failing job leaves criterion 6 reported as unverified, and the `ci.yml` literal moves only to match the real inventory — never by weakening, skipping or removing an existing test (P2.2, P11, P20, P-10, P-12) |
| No whole-file buffering and no scratch storage introduced merely to avoid a second source read | the cost is documented instead (P7's paragraph, §10.2's formula), `ContentHandle` lost its `sha256` rather than gaining a buffer, and criterion 4's third assertion proves pass 1 retains nothing |
| An ADR is not *Accepted* because its implementation was planned | §14.1's three-part rule, restated as P20's gate; only ADR-0027/0028/0040 are eligible and only in the handoff that reports passing tests (P2.2, P19's P-7′) |
| Status wording must distinguish database tables from application workflow consumers | "no route, no table, no consumer" is prohibited and replaced by the four-way absence table (§1.3) and criterion 11's form; P2.2's `docs/architecture.md` row carries the corrected sentence |
| **D-12 stays exactly as resolved** | rule E is untouched by this pass: compliance evidence is fully verified before any response body byte is released, with **no threshold, no tunable and no unverified-stream exception**; a verification that cannot complete fails closed (`503 verification_unavailable`, `deferred`, zero bytes) and a disagreement fails closed (`409 checksum_mismatch`, `denied_by_policy`, `QUARANTINED`); the `archive_verify_before_serve_bytes` ceiling remains institutional-archive-only, i.e. rule A and D-25's posture (§6.4, §6.4a, I-3) |
| No commit, push, deploy, reset, clean, rebase, stash or branch change | **two documentation files** are the whole diff of both passes — this plan and the architecture document. No application code, model, migration, test, CI workflow, dependency, environment or runtime-configuration file was edited, and no migration, test suite, server or emulator was run. Nothing was staged or otherwise recorded in Git, and every pre-existing uncommitted change — the Phase 6.x storage work and the GitHub Desktop stash — is untouched. P20's report lists what changed for your approval, and implementation starts only on it |
