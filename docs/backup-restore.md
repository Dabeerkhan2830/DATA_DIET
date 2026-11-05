# Backup and restore runbook (MySQL)

**Scope.** The DataDiet MySQL 8.x database. The development compose file pins
`mysql:8.4`; the migration suite and the drill below used MySQL 8.0.46. Alembic
is supported only on MySQL (see `docs/setup.md` section 8).

**Status.** This procedure was authored and drilled on 2026-10-20 against a
disposable local instance (section 9). It has **not** been exercised against a
production database, a managed provider, production data volumes, or a live
restore. A restore drill on disposable infrastructure is evidence about the
procedure, not proof that a production backup is recoverable.

A file existing is not a backup. A backup is a dump that passed the integrity
checks in section 4 **and** was restored into a separate scratch database with
its Alembic revision and data verified (section 5). The application stores
metadata only today, but a dump still contains the local user directory, audit
events, and institution data: treat every dump as confidential.

## 1. Identify the target before touching anything

1. Read the change ticket and confirm the intended environment, host, port and
   database name.
2. From `backend/`, with the intended environment loaded, run the read-only
   preflight:

   ```powershell
   Set-Location C:\Users\yadav\Desktop\DataDiet\backend
   ..\.venv\Scripts\python.exe ..\scripts\migration_preflight.py
   ```

   It prints the environment, a credential-free target, the stamped revision,
   the repository head, and pending revisions. A non-zero exit code is a stop
   signal (see `docs/setup.md` section 8.1).

3. Confirm the same facts with a read-only SQL session:

   ```sql
   SELECT @@hostname AS host, @@port AS port, DATABASE() AS db, VERSION() AS version;
   SELECT version_num FROM alembic_version;
   ```

4. Record the host, port, database, engine version, revision, current UTC time,
   and operator in the change ticket. If any value disagrees with the ticket,
   stop. For production, have a second person confirm the target before a dump
   or restore.

## 2. Credentials (two separate least-privilege identities)

Never put a password on the command line (`-pSECRET`) or in a committed file:
it leaks through shell history, process listings, and logs. Use **two separate
client option files** outside the repository, each restricted to the operator's
account:

- a **read-only backup** identity for section 3;
- a **scratch/restore** identity that can write only the disposable drill
  database for section 5. It must not be able to write the source database.

```powershell
$backupCnf = Join-Path $env:USERPROFILE ".datadiet-backup.cnf"
$scratchCnf = Join-Path $env:USERPROFILE ".datadiet-scratch.cnf"
# Create both files in an editor; do not echo a password into a terminal.
icacls $backupCnf /inheritance:r /grant:r "$($env:USERNAME):(R)"
icacls $scratchCnf /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

Backup file (`$backupCnf`):

```ini
[client]
host=<db-host>
port=3306
user=datadiet_backup
password=<injected-from-secret-manager>
ssl-mode=VERIFY_IDENTITY
ssl-ca=C:/path/to/ca.pem
```

Scratch/restore file (`$scratchCnf`):

```ini
[client]
host=<db-host>
port=3306
user=datadiet_restore
password=<injected-from-secret-manager>
ssl-mode=VERIFY_IDENTITY
ssl-ca=C:/path/to/ca.pem
```

The DBA creates the accounts and grants, using the institution's secret
manager; no password belongs in this document or in shell history. A
least-privilege example (the DBA must adapt host names, database names, TLS, and
whether routines exist):

```sql
-- Read-only backup identity: no INSERT/UPDATE/DELETE/DDL, and no TRIGGER or
-- EVENT (those privileges also permit changes). This schema currently has no
-- triggers, routines, or events; confirm that before relying on the dump.
CREATE USER 'datadiet_backup'@'<backup-host>' IDENTIFIED BY '<from-secret-manager>';
GRANT SELECT, SHOW VIEW
  ON `<database>`.* TO 'datadiet_backup'@'<backup-host>';

-- Scratch restore identity: only the pre-created disposable drill database.
-- Do not grant these privileges on the source database. TRIGGER is omitted
-- because the documented dump skips triggers; extend only with a reviewed need.
CREATE USER 'datadiet_restore'@'<restore-host>' IDENTIFIED BY '<from-secret-manager>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES,
      LOCK TABLES
  ON `datadiet_restore_drill`.* TO 'datadiet_restore'@'<restore-host>';
```

If routines are added later, the backup role needs `SHOW_ROUTINE` (read-only)
and the dump needs `--routines`; if triggers or events exist, the DBA must decide
whether to grant the non-read-only `TRIGGER`/`EVENT` privileges or use a
provider snapshot instead. Do not quietly broaden the backup identity.

Have the DBA create `datadiet_restore_drill` before granting, or grant only the
minimum needed to create that exact database. Never grant the scratch identity
rights on the source or application database. A restore over a live database
requires a separate, DBA-approved operator credential and the approval in
section 6; the backup credential is never used for a restore.

- Do not print `DATABASE_URL` or an option file. The preflight command masks
  the target on purpose.
- Delete both option files when done, or keep them only in a
  secrets-managed location with access logging. Never commit them; `.env` and
  dump files are not repository artifacts.

## 3. Create the backup

- Use a timestamped name and a directory outside the repository, with enough
  free space for the dump and a scratch restore.
- Quiesce schema changes during the dump. `--single-transaction` gives a
  consistent snapshot for InnoDB tables, but it does not block DDL; coordinate
  with a migration or maintenance window.
- Do **not** use `--databases` if the dump may be restored under a different
  (scratch) name: `--databases` embeds `CREATE DATABASE` / `USE` for the source
  name. Dump the single database name instead.
- Do **not** use `--all-databases`.

```powershell
$backupDir = "D:\datadiet-backups"          # outside the repository
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$dump = Join-Path $backupDir "<database>-$stamp.sql"

& mysqldump --defaults-extra-file="$backupCnf" `
    --single-transaction --skip-triggers --skip-routines --skip-events `
    --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4 `
    --result-file="$dump" "<database>"

if ($LASTEXITCODE -ne 0) {
    throw "mysqldump failed with exit code $LASTEXITCODE; do not use this file."
}
```

`--result-file` matters on Windows PowerShell 5.1: redirecting native output
with `>` writes UTF-16LE, which corrupts a SQL dump. Use `--result-file` (or
`cmd /c` redirection) instead.

The `--skip-*` flags match the read-only backup grant above. If the schema gains
triggers, routines, or events, stop and have the DBA approve an appropriate
backup method; do not silently use a write-capable backup account for a
supposedly read-only credential.

If the platform provides snapshots, use the provider's snapshot mechanism as
well or instead, following the provider's restore procedure. A snapshot still
needs a test restore; a snapshot's existence is not verification.

## 4. Check the backup's integrity

Run every check and record the results in the change ticket:

```powershell
(Get-Item $dump).Length                       # must be > 0
(Get-FileHash -Algorithm SHA256 $dump).Hash   # record separately from the dump
(Select-String -Path $dump -Pattern '^CREATE TABLE ').Count
Get-Content $dump -Tail 1                     # must contain "Dump completed"
```

- Compare the dump's `CREATE TABLE` count with the source database's table
  count (`SHOW TABLES`), allowing for views if any exist.
- The SHA-256 is recorded in the ticket or a separate store, not only next to
  the dump; it detects silent modification in storage.
- A clean `mysqldump` exit code and a `Dump completed` marker are necessary but
  not sufficient. The restore drill in section 5 is the authoritative check.
- If any check fails, discard the file and re-run the dump. Never hand-edit or
  "repair" a dump.

## 5. Restore drill into a separate scratch database

Use a scratch database that is clearly named and is **not** the source or an
application database. Never restore over the source as the first step.

```powershell
$scratchDb = "datadiet_restore_drill"
$confirmed = Read-Host "Type the exact scratch database name to create/overwrite"
if ($confirmed -ne $scratchDb) {
    throw "Scratch target not confirmed; no database was created or changed."
}

& mysql --defaults-extra-file="$scratchCnf" -e `
    "CREATE DATABASE ``$scratchDb`` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"

# SOURCE is a mysql-client command; it avoids PowerShell '<' redirection.
& mysql --defaults-extra-file="$scratchCnf" $scratchDb -e `
    "SOURCE C:/path/to/<database>-<timestamp>.sql"
```

Verify the restored schema and data:

```sql
SELECT version_num FROM datadiet_restore_drill.alembic_version;
SELECT COUNT(*) FROM datadiet_restore_drill.app_users;
SELECT COUNT(*) FROM datadiet_restore_drill.audit_events;
CHECKSUM TABLE datadiet_restore_drill.alembic_version,
               datadiet_restore_drill.app_users,
               datadiet_restore_drill.audit_events;   -- repeat for every table
```

Compare each table's checksum with the source. A checksum mismatch, a missing
table, or an unexpected revision means the dump is not accepted.

Then verify the revision with the actual operator tooling, against the scratch
database only. Read the scratch password without echoing it, keep the URL only
in this process, and clear it in a `finally` block:

```powershell
$scratchSecure = Read-Host -AsSecureString "Scratch restore password"
$scratchBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($scratchSecure)
try {
    $scratchPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($scratchBstr)
    $env:DATABASE_URL = "mysql+pymysql://datadiet_restore:" +
        [uri]::EscapeDataString($scratchPassword) +
        "@<host>:<port>/$scratchDb"
    $env:ENVIRONMENT = "development"

    Set-Location C:\Users\yadav\Desktop\DataDiet\backend
    ..\.venv\Scripts\alembic.exe current
    ..\.venv\Scripts\python.exe ..\scripts\migration_preflight.py
}
finally {
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:ENVIRONMENT -ErrorAction SilentlyContinue
    Remove-Variable scratchPassword -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($scratchBstr)
    Remove-Variable scratchBstr, scratchSecure -ErrorAction SilentlyContinue
}
```

Expected: `alembic current` reports the same revision as the source, and the
preflight exits `0` with the scratch target at the repository head. If the
restored revision is older than head, do not upgrade the scratch database
informally; follow `docs/setup.md` section 8 when restoring a database that
matters.

Run an optional engine-level check on the scratch database if `mysqlcheck` is
available:

```powershell
& mysqlcheck --defaults-extra-file="$scratchCnf" --check $scratchDb
```

Drop the scratch database only after recording the evidence and typing its exact
name again. Dropping a scratch database created for the drill is expected;
dropping anything else is a destructive action requiring the approval in
section 6.

```powershell
$dropConfirmed = Read-Host "Type $scratchDb again to drop this scratch database"
if ($dropConfirmed -ne $scratchDb) {
    throw "Scratch drop not confirmed; nothing was dropped."
}
& mysql --defaults-extra-file="$scratchCnf" -e "DROP DATABASE ``$scratchDb``;"
```

## 6. Restoring over a database (destructive)

A restore over an existing database destroys its current contents. It requires
written approval before any command runs.

Preconditions:

- an approved change ticket naming the environment, host, port, and exact
  target database, plus the approver;
- a maintenance window with application writers stopped;
- a **fresh, verified** backup of the current target (section 3-5), not just an
  older backup;
- a documented recovery plan for platform administrators if the restored
  revision predates `0011` (see `docs/setup.md` section 8.4);
- a rollback plan: keep the old database or a provider snapshot until sign-off;
- two people: one operates, one confirms the target and the commands.

Before executing, have the operator state aloud and in the ticket: "I confirm
the target is `<database>` in `<environment>`; approval is `<ticket>`; a
verified backup exists." Type the database name rather than copying it from a
convenient buffer. The following gate must pass in the interactive session
before any destructive command is run; do not paste commands from this section
until both checks pass.

```powershell
$target = Read-Host "Type the exact target database name"
$approved = Read-Host "Type the approved change-ticket id"
if ($target -ne "<database>") { throw "Target not confirmed; no restore was performed." }
if ($approved -ne "<ticket>") { throw "Restore approval not confirmed; no restore was performed." }
```

This runbook does not itself authorize a destructive restore. The approval,
the second-person confirmation, the fresh verified backup, and the recovery
plan above are all prerequisites; a restore drill must stop at section 5.

Preferred sequence:

1. Restore into a new/scratch database and verify revision, row counts, and
   checksums.
2. Stop the application and confirm readiness is failing (no writers).
3. Take the final backup of the current target and verify it.
4. Cut over to the restored database (rename or provider restore), or restore
   into the target only after the verified scratch restore and approval.
5. Start the application and check `/api/v1/health/ready`.
6. Run `alembic current` and the preflight. If the revision is below head,
   follow the migration runbook rather than editing `alembic_version`.
7. Verify the platform-administrator list and re-grant only individually
   verified accounts through `scripts/bootstrap_admin.py`.
8. Keep the old database or snapshot until the application and audit checks
   pass, then remove it under the same approval.

Do not restore a `--databases` dump over a differently named database, do not
delete the old database before verification, and do not "fix" a partial restore
by editing tables or the version table by hand.

## 7. Retention and secure storage

- Encrypt dumps at rest and in transit. Store them on access-controlled,
  backed-up storage outside the application host where possible.
- Keep the checksum separately from the dump; restrict who can alter either.
- Define retention with the institution's records policy. Keep enough history
  to meet the agreed RPO, and delete expired copies securely; an accumulating
  pile of unverified dumps is itself a data-protection risk.
- Audit access to backups. Backups contain account emails, audit payloads, and
  institutional metadata even though DataDiet does not store file contents.
- Never commit a dump, put one in chat/email, or copy one into the repository
  or a frontend asset directory.
- Test a restore at least quarterly and after any migration that changes the
  schema. Record the date, source revision, dump checksum, scratch result, and
  operator. A backup job that reports success without a restore drill is not
  verified.
- Monitor backup job success, dump age, and restore-drill completion; alert on
  failure or a missed schedule.

## 8. Troubleshooting

| Symptom | Action |
| --- | --- |
| `Access denied` for the backup account | Check the option file path/ACL, the account's host grant, and its authentication plugin. Do not grant global privileges as a shortcut. |
| `Unknown database` on restore | Create the scratch database explicitly; do not edit the dump to add `CREATE DATABASE`. |
| Checksum mismatch or missing tables | Discard the dump and re-run it. Do not restore over a live database. |
| Restore stops part-way | Drop the scratch database and start again from a verified dump; never continue into a live target. |
| `Dump completed` missing | Treat the dump as truncated; discard and re-run. |
| Revision unknown or off-chain | Stop; run `migration_preflight.py` and resolve the revision. Never update `alembic_version` by hand. |
| Charset/collation errors | Use `utf8mb4` and the source collation (`utf8mb4_0900_ai_ci` for MySQL 8); inspect the dump header rather than guessing. |
| Lock wait/timeout during dump | Use a maintenance window and `--single-transaction` for InnoDB; do not switch to a locking mode without DBA approval. |
| GTID errors on restore | Use `--set-gtid-purged=OFF` for a logical dump, or follow the managed provider's GTID restore procedure; do not hand-edit GTID state. |
| Disk full | Free space and re-run; never truncate a dump or restore file. |
| Application returns 503 after restore | Check `/api/v1/health/ready`, database credentials/network, `alembic current`, and the administrator recovery state. |
| `DEFINER`/routine errors | Current schema has no routines, but if added, use the DBA's grant procedure; do not disable `sql_mode` or strip security clauses blindly. |

## 9. Drill record (Phase 9, 2026-10-20)

Performed only on a disposable MySQL 8.0.46 instance at `127.0.0.1:3307`; no
production, demo, or durable database was written to. The repository head is now
`0012_audit_platform_admin_reset` (an audit-only revision); the drill below
predates it and was recorded at `0011`, which is historically accurate. Re-run
the drill after any schema-changing migration.

- Source: `datadiet_mig` at `0011_platform_admin_default_false`, 21 tables,
  1 `app_users` row, 2 `audit_events` rows. `datadiet_demo` was verified still
  at `0010_classification_downgrade_safety` before and after the drill.
- Dump: 33,686 bytes, 21 `CREATE TABLE` statements, no `USE` statement, clean
  `Dump completed` marker, exit code 0.
- SHA-256: `4316F41CC89F3BDF4D562CF3A0AFC23B5F0138D588E3D17EA0461BC600BA4D2B`.
- Scratch restore: `datadiet_restore_drill`, restore exit code 0; all 21 table
  checksums matched the source; `alembic current` reported
  `0011_platform_admin_default_false (head)`; `migration_preflight.py` exited 0
  with no pending revisions; 1 user and 2 audit events restored.
- Cleanup: scratch database dropped and dump deleted after recording the
  checksum; source data unchanged.

**What this drill did not test.** The drill did not exercise the separate
read-only `datadiet_backup` and scratch-only `datadiet_restore` accounts or the
secure-password prompt in section 5; it used the disposable instance's local
administrative access. It did not test production data volume, managed-provider
snapshots, point-in-time recovery, encryption/key management, a restore over a
live database, Windows ACL behavior for a real option file, or an actual
stakeholder-approved recovery. The first production use must be a scheduled
rehearsal on staging with the real provider's backup mechanism and real
least-privilege accounts.

