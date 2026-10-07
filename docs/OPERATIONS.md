# Operations and maintenance

## 1. Current repository state

The repository currently contains documentation only. Application commands, environment variables, deployment procedures, and runtime observability are not yet implemented. This document defines requirements for adding them; it does not imply those capabilities already exist.

## 2. Development workflow when code is introduced

- Use a supported Node.js LTS version and pin the package manager/version in repository configuration.
- Keep local setup reproducible from a clean checkout; document exact install, test, lint, type-check, and build commands.
- Commit lockfiles. Do not commit `.env` files, credentials, local databases, book files, or build output.
- Provide a local development mode that does not require production Cloudflare credentials.
- Make type-checking, formatting, lint, unit tests, and build validation part of CI before merging.
- Keep UI components thin and test domain services, repositories, renderer adapters, and sync invariants independently.

## 3. Configuration and secrets

Configuration should be validated at application startup and separated into public build-time settings and server-only secrets. Production secrets belong in the deployment platform's secret manager, not source control. Provide example names and descriptions, never real values. Rotate compromised credentials and ensure logs do not reveal them.

Expected configuration categories, to be concretized with implementation:

- Public app origin and API base URL.
- Cloudflare account/resource bindings for Worker deployment.
- Access audience/issuer configuration.
- Local test/dev toggles that cannot disable production authorization accidentally.

## 4. Schema migrations

- Check in numbered, ordered D1 migrations and explicit local database version migrations.
- Test upgrade from empty state and every supported prior schema fixture.
- Test interrupted/retried migration behavior where platform semantics permit.
- Document backup/export expectations before migrations that may transform or remove data.
- Deploy additive server changes before clients that depend on them; define how stale clients are rejected safely.
- Do not perform destructive data cleanup in a schema migration without an explicit reviewed recovery plan.

## 5. Quality gates

Before a milestone is considered releasable:

- All tests, lint, type checking, and production build pass.
- Import and reader regression corpus passes on supported browsers/webviews.
- Offline behavior is tested with network disabled, including app reload and browser restart.
- Sync tests cover replay, partial failure, cursor safety, conflict handling, and authentication expiry.
- File transfer tests cover interruption, resumed work, checksum mismatch, quota failure, and duplicate content.
- Accessibility keyboard/focus checks and representative screen-size checks pass.
- Dependency licenses and vulnerability notices are reviewed.

## 6. Deployment and release

Use separate development and production resources and least-privilege credentials. Deploy reviewed database migrations before dependent Worker behavior. Verify Access enforcement, private R2, and route exposure before serving private data. Keep static app rollout compatible with supported stored schemas and sync envelope versions.

A release record should include version/commit, migration range, known format limitations, recovery notes, and rollback constraints. Rolling back frontend code must not roll back or corrupt user data.

## 7. Operational signals

Expose local diagnostics to the user without sending telemetry by default:

- Last successful sync and current sync state.
- Count and age of pending changes.
- Transfer queue state and retryable/permanent errors.
- Current pull cursor and schema versions in an exportable diagnostic bundle, with private content excluded.
- Local storage estimates and file presence.

Server monitoring may record request ID, route, duration, response status, rate limiting, and coarse error categories. It must omit tokens, signed URLs, book contents, and annotation text. Any remote telemetry or user analytics requires an explicit privacy decision.

## 8. Backup, export, and restore

Manual JSON/Markdown export and original-file archive are the first supported recovery mechanism. Before production sync, document how to export, validate an export, and restore into a clean client. Test restoration periodically with fixtures. Automated backup is deferred until credentials, encryption, retention, and restore are specified; a backup that has never been restored is not considered validated.

## 9. Incident and recovery runbooks

### Device lost or browser storage evicted

1. Reinstall/open client and authenticate.
2. Bootstrap metadata from server cursor zero (or supported snapshot).
3. Download books on demand or pin them again.
4. Verify counts and report missing objects without silently advancing past errors.

### Sync stuck

1. Inspect pending count, last success, auth, connectivity, and error category.
2. Retry transient work; do not clear the outbox.
3. Export local data if possible before repair/reset.
4. Capture a sanitized diagnostic bundle; never include content or credentials.

### File integrity failure

1. Mark local copy unavailable and preserve metadata/annotations.
2. Re-download or re-import from a trusted original.
3. Verify hash before marking available.
4. Avoid deleting the remote object until its state is independently verified.

### Accidental deletion

Use the tombstone/retention recovery path. Do not restore by directly editing production D1. If remote bytes were explicitly removed, recovery requires another original or a verified backup.

## 10. Cost and quota review

Before launch and periodically, review current Cloudflare plans, D1/R2 limits, browser storage behavior, and any package/API costs. Record observed usage and configure alerts where available. Cost assumptions are not architectural constants; keep service adapters replaceable and exports portable.
