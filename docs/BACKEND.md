# Cloudflare backend

## 1. Scope

The backend provides authenticated synchronization and durable file storage. It does not render books or sit on the critical path for local reading. Design for a single user's workload and current free/low-cost plans, then verify actual limits and prices before deployment.

## 2. Services and responsibilities

| Component         | Responsibility                                                                   | Security boundary                                                                                   |
| ----------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Cloudflare Pages  | Serve the static PWA assets                                                      | Access policy protects the private application if desired; cache only public application assets.    |
| Cloudflare Access | Authenticate the user                                                            | Worker must verify signed identity headers/assertion; do not trust arbitrary client-supplied email. |
| Worker + Hono     | API validation, authorization, sync orchestration, signed transfer authorization | Every route checks identity, method, body size, schema, and allowed operation.                      |
| D1                | Replicated metadata, idempotency records, sequenced change log                   | Bind queries, use transactions where required, and minimize personal text in logs.                  |
| R2                | Original books and cover derivatives                                             | Private bucket; no public object access.                                                            |

Exact service bindings, free-tier limits, upload mechanisms, and Access integration must be verified at implementation/deployment time. Do not assume an S3-style presigned operation exists in a specific form without validating the selected Cloudflare APIs and plan.

## 3. API baseline

All endpoints are under `/api/v1`, authenticated, HTTPS-only, and versioned. Request and response schemas must have shared TypeScript types plus runtime validation.

| Method and path                         | Purpose                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/v1/sync/push`                | Idempotently submit a bounded batch of local changes.                                    |
| `GET /api/v1/sync/pull?since=&limit=`   | Fetch sequenced changes after an exclusive cursor.                                       |
| `POST /api/v1/files/upload-authorize`   | Authorize upload for a declared hash and size; return short-lived transfer instructions. |
| `POST /api/v1/files/upload-complete`    | Verify and register a completed object upload.                                           |
| `POST /api/v1/files/download-authorize` | Authorize access to a known remote object.                                               |
| `GET /api/v1/files/:sha256/status`      | Query remote presence/size without exposing object content.                              |
| `GET /api/v1/export`                    | Optional later server-side metadata export; client-side export is initial requirement.   |

The exact file-transfer protocol (single PUT versus multipart) depends on file size limits and R2 capabilities. Endpoint naming does not imply that a Worker proxies file bodies.

## 4. Authentication and authorization

Cloudflare Access is the initial choice. Configure the Worker so requests cannot bypass Access through a direct hostname or alternate route. Validate the Access JWT signature, issuer, audience, and expiration using Cloudflare's supported mechanism; use identity only after validation. The single-user allowlist is deployment configuration, not a client-side check.

- Auth required on all API routes, including status and export.
- CORS allowlist is restricted to known app origins; CORS is not authorization.
- Signed transfer URLs are short-lived, scoped to one object and operation, and omitted from logs.
- Never return private bucket names/credentials or allow arbitrary key selection.
- No reusable secret is shipped in browser bundles.

If Access proves impractical, bearer-token auth requires a separate ADR covering secure storage, rotation, revocation, and recovery; do not silently switch mechanisms.

## 5. Sync application

On push, validate batch and each change, then within a transaction check idempotency IDs, apply conflict rules, persist accepted state, and append a server change-log row with monotonically increasing sequence. A duplicate ID returns its prior outcome and does not append a second event. Partial batch outcomes are explicit.

On pull, query ordered rows after `since`, bounded by row and byte limit. The cursor is exclusive. Retention/compaction must return a clear expired-cursor response rather than partial history. See [Sync](SYNC.md) for convergence and client rules.

## 6. File lifecycle

1. Client declares SHA-256, size, and format using authenticated authorization.
2. Worker validates limits and returns scoped short-lived transfer details.
3. Client sends bytes directly to private R2; large file handling uses a supported multipart flow.
4. Client calls completion; backend verifies actual object existence, size, and checksum where the platform supports it. If checksum verification cannot be performed server-side, require a trustworthy client confirmation plus independent verification on download and document the residual limitation.
5. Backend records availability only after successful completion.
6. Download authorization is returned only for an existing object; client verifies SHA-256 before setting local availability.

Duplicate hash upload should resolve to the existing object without creating duplicate bytes. Abandoned multipart uploads require an expiration/cleanup policy. Deleting metadata does not automatically delete R2 content.

## 7. D1 schema and operations

Keep migration SQL in source control. Separate replicated entity tables, idempotency records, and append-only change log. Use indexes for primary access paths, parameterized queries, and batches/transactions that preserve event atomicity. Establish maximum payloads and pagination before public deployment. Test migrations on empty DB and representative prior schemas.

D1 and R2 are not a single transaction. The upload workflow is a state machine designed for retries and reconciliation. A periodic audit can detect objects without metadata and metadata whose object is missing; it must report before deleting anything.

## 8. Cost controls

- Batch metadata changes and debounce progress events.
- Avoid write-heavy KV usage for authoritative metadata.
- Keep covers small and generate once per original/metadata policy.
- Bound upload size, request size, pull page size, and concurrency.
- Monitor storage, request counts, and error rates against current plan limits.
- Keep export/restore independent from Cloudflare so migration remains possible.

## 9. Logs and privacy

Log request IDs, route, timing, status, and coarse error category. Do not log authentication assertions, bearer tokens, signed URLs, full book titles, annotation text, or request bodies containing user content. Define retention and access for operational logs before production use.

## 10. Deployment checklist

- Separate dev/prod Pages, Worker bindings, D1, R2, and Access policy.
- Verify authentication on every path, including direct Worker URLs.
- Verify R2 bucket is private and object keys are content-derived, not user-controlled paths.
- Apply reviewed D1 migrations and verify rollback/recovery approach.
- Test duplicate push, partial push, cursor pagination, expired cursor, interrupted upload, checksum mismatch, and denied Access.
- Recheck current Cloudflare pricing and quotas.
