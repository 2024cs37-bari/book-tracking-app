# Operations and release

## Development and release evidence

Install both packages from lockfiles, then run `npm run check:all`. Browser regressions use actual
engines and production assets; corpus acquisition is explicit and stores licensed originals outside
the repository. Server tests exercise local Worker/D1/R2 bindings, independently of deployed Access.
CI separates deterministic checks from upstream-dependent corpus work; inspect `.github/workflows/ci.yml`
for exact triggers. [Development](DEVELOPMENT.md) records local evidence, not presumed CI results.

Before a release, record app version/source snapshot, dependency versions, migration range, browser
results, corpus scope, known limits and recovery instructions. Do not claim Safari/Android hardware
support from desktop Playwright alone. Keep build artifacts and logs out of source control.

## Deployment

1. Create separate development/production D1 and private R2 resources; supply actual binding IDs.
2. Configure the Access application, allowed identity policy, audience and team domain. Verify
   alternate/direct Worker hostnames cannot bypass the intended policy.
3. Configure exact CLIENT_ORIGIN if frontend and API origins differ. Never deploy a development
   identity bypass or a reusable secret in a public Vite variable.
4. Apply reviewed D1 migrations before dependent API changes. Check empty and prior-schema paths.
5. Deploy the Worker following [server README](../server/README.md), then build the frontend with
   the validated API base. Deploy the full matching app-shell/engine asset set atomically.
6. Verify real login, denied login, unauthenticated API denial, CSP/CORS, two-device convergence,
   original upload/download and restored backup with non-private test fixtures.
7. Recheck current Cloudflare request/storage limits and cost controls in the owner account.

This work requires account access and cannot be certified by local tests. Never claim a successful
production deployment without checking its actual route and authentication behavior.

## Safe app updates

The offline cache contains app assets only; private API/auth paths bypass shell caching. New
workers wait for active tabs to close, preserving existing reader engines during a session. Keep
older hashed assets available through a compatibility window; removing them during a rollout can
break an older open app or failed offline update. [Offline app](OFFLINE-APP.md) documents the policy.

Database changes are forward-only. Rolling back frontend assets must not roll back stored data or
run code that cannot understand its schema. Make server changes additive before clients depend on
them; reject unsupported schemas visibly instead of accepting corrupted payloads.

Local schema v4 normalizes existing tag lookup keys without changing their IDs, labels, clocks,
memberships or queued/acknowledged outbox payloads. The replicated schema stays v2. Upgrade all
devices before exchanging language-sensitive tag names: pre-v4 clients used the device locale for
validation. Current clients accept those legacy keys during sync and backup recovery. Migration
tests cover retained duplicate identities and immutable outbox payloads; no tags are auto-merged.

## Backup and recovery

Metadata JSON is not an original-file backup. The portable ZIP format is bounded and includes
verified available originals; oversized/incomplete libraries need JSON plus separately preserved
original files. Keep backups outside browser storage and rehearse recovery into a clean profile.

Recovery validates a preview, adds missing data with fresh local events and preserves current
records. It does not reset device identity/cursors or restore stale queue state. Staged originals
survive metadata rollback and can be reconciled later. [Backup](BACKUP.md) is the format contract.

## Incident procedures

### Device loss or browser eviction

Restore a verified portable backup, or authenticate to pull retained server history and download
originals on demand. Re-pin on the new device. Verify actual file presence and hashes, not just
metadata counts. If cloud originals were never uploaded, obtain an external original copy.

### Stuck synchronization

Inspect state, pending count, authentication, next retry and file errors. Retry transient failures;
reauthenticate for auth expiry. Export before manual repair. Never clear outbox rows simply to show
zero pending work. A permanently rejected event needs diagnosis with a sanitized fixture, not loss
of the user's edit. Server log retention is currently complete; compaction needs a snapshot design.

### Integrity failure

Keep metadata and annotations. Re-import a trusted original or download a verified remote copy.
Reject mismatched bytes before marking local availability. Do not overwrite a trusted remote object
with failed input; do not evict the last local copy using an unverified remote availability claim.

### Accidental removal

Archive is reversible. Metadata deletion retains a tombstone and original reference. Ordinary
cleanup does not remove tombstoned originals; permanent remote purge is not an implicit lifecycle
action. Restore through the application/backup path rather than ad-hoc production database edits.

### Failed reader save

Retry while the app remains open. A scoped recent locator journal can recover the pending position
on reopen, provided localStorage or in-memory intent survived. Both stores failing or a terminated
browser can still lose uncommitted intent. State that limit clearly.

Current journal keys are
`book-reader:unsaved-position:v1:<encodeURIComponent(databaseName)>:sha256:<originalHash>`.
They survive canonical book UUID changes. Old keys ending in a book UUID are migrated by the
requested route or a bounded namespace scan matching the original hash (30-day age limit).
Migration retains the original key if writing the new key fails. Do not delete old alias journal
keys as cosmetic cleanup before confirming the pending position is durably saved. Journals contain
locators and hashes, not excerpts; treat them as private reading state.

## Diagnostics and privacy

Settings can download an allowlisted JSON report with app/schema versions, local storage
type/estimates, aggregate library/outbox/transfer counts, coarse sync state and last metadata
success. It contains no device/book/account identifiers, server addresses, raw errors or content.
See [Diagnostics](DIAGNOSTICS.md). The broader Settings view includes device identity and collections;
share the exported report instead of assuming every Settings screenshot is anonymous. Exclude tokens, Access assertions, request
bodies, annotation text, selected words and personal book content from logs and public artifacts.

There is no analytics requirement. Dictionary lookup is optional with consent; platform speech
voices can have their own network behavior. Private R2 is not end-to-end encryption. Automated
external backups, key management and telemetry need explicit product/recovery decisions.

## Maintenance backlog

Measure outbox/change-log growth, request counts and R2 usage before setting retention or raising
limits. Review pinned renderer security fixes and the private pdf.js stream hook on upgrades. Run
focused regression first, then browser/corpus gates for rendering changes. Keep architecture,
contracts, migration notes and user-facing limits updated in the same slice as implementation.
