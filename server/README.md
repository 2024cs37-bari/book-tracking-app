# Private sync Worker

The backend stores an ordered, idempotent metadata change log in Cloudflare D1
and original book files in private R2. Cloudflare Access gates every data route
and scopes records by verified user identity. The frontend works without this
server; configuring `VITE_SYNC_URL` enables cross-device features.

The maintained [API contract](../docs/API.md) covers request shapes, limits,
retries, authentication, and file lifecycle. [SYNC.md](../docs/SYNC.md) describes
client conflict resolution. No remote resources or credentials are included.

## Local development

Use the same supported Node version as the root project (Node 20.19+; a current
LTS version is recommended). Work in `server/`:

```sh
npm ci
npm run typecheck
npm test
npm run migrate:local
```

Create `server/.dev.vars` locally:

```dotenv
DEV_USER=local-reader
CLIENT_ORIGIN=http://127.0.0.1:5173
```

Run `npm run dev`, which binds Wrangler to `127.0.0.1:8787`. In a second terminal
at the repository root run:

```sh
VITE_SYNC_URL=http://127.0.0.1:8787/api npm run dev -- --host 127.0.0.1
```

Use the frontend at `http://127.0.0.1:5173`; `localhost` is a different origin.
The bypass is allowed only for loopback request URLs and must never be configured
in a remote environment. `.dev.vars` is local only and Wrangler does not upload
it. Local D1/R2 state is under `.wrangler/`; deleting it deletes your development
server data.

`npm test` includes pure validation tests, real JOSE signature checks with local
keys, and the bundled Worker running in local workerd with D1/R2. It requires no
Cloudflare account or network service. Miniflare and esbuild are explicit test
dependencies; its version matches the Wrangler runtime. Do not replace these
checks with an in-memory API mock when changing storage behavior.

## Deployment checklist

Prefer one HTTPS host: a static frontend with `/api/*` routed to this Worker.
This avoids cross-site Access cookie restrictions and simplifies CSP. Choose the
host and Access policy before provisioning resources.

1. Authenticate Wrangler using your own Cloudflare account. Do not place tokens
   in the frontend, `.env` values beginning with `VITE_`, logs, or committed files.
2. Create the resources using `npx wrangler d1 create book_reader_sync` and
   `npx wrangler r2 bucket create book-reader-files`. Keep R2 public access off.
   Replace `database_id` in `wrangler.toml` with the resulting D1 ID. If you use
   different resource names, update bindings and migration scripts together.
3. Add the real Worker route for `your-reader-host.example/api/*` in
   `wrangler.toml` or your deployment-specific configuration. The checked-in
   configuration disables `workers.dev` and preview URLs and has no production
   route. It intentionally does not create an alternative public endpoint.
4. Create a Cloudflare Access application covering the chosen host/routes and
   allow only the intended owner. Set `ACCESS_AUD` to its audience tag and
   `ACCESS_TEAM_DOMAIN` to `<team>.cloudflareaccess.com` in the deployment config.
   These two identifiers are public configuration, not authentication secrets.
   Never set `DEV_USER` remotely. Empty Access values fail closed.
5. Set `CLIENT_ORIGIN` to the exact HTTPS frontend origin, such as
   `https://reader.example.test`, with no path or trailing slash. Same-origin
   requests work when it is unset. A separate frontend/API domain additionally
   requires Access to let preflight reach the Worker and browsers to send the
   API's Access cookie; test this explicitly.
6. Apply the schema: `npm run migrate` targets remote D1. First review the SQL
   and keep a backup when upgrading an existing deployment. `migrate:local`
   never updates the remote database.
7. Run `npm run typecheck`, `npm test`, and
   `npm run deploy -- --dry-run` to validate the bundle and bindings. Then run
   `npm run deploy` when you are ready to publish your configured Worker.
8. Build the frontend with
   `VITE_SYNC_URL=https://reader.example.test/api npm run build` at the root and
   deploy `dist/` to the frontend host. The API origin is added to application
   CSP at build time. Changing it requires rebuilding the frontend.
9. Verify unauthorized API calls fail, sign in through Access in a browser,
   import a disposable book, sync it, then download/verify it on a second device.
   Confirm protected originals have no public R2 URL and that a second
   unauthorized identity cannot access metadata or files.

The deployment commands create billable Cloudflare resources or publish code;
they are setup instructions, not actions performed by tests. Resource IDs,
Access policy, real host, and credentials remain operator responsibilities.

## Maintenance and recovery

- Back up D1 and original R2 files separately; the client's JSON backup does not
  include book bytes. See [operations](../docs/OPERATIONS.md).
- Keep immutable change IDs across retries. D1 enforces uniqueness per user and
  rejects reuse with different content. Clients must retain/surface rejected
  changes instead of silently dropping them.
- Original PUT streams are limited to 100,000,000 bytes and checksum-verified by
  R2 before publication. Downloads stream back and are verified by the client.
  Legacy objects without recorded checksums remain recoverable by GET but must
  be re-uploaded before they can justify evicting a local copy.
- Keep the Worker and client schema compatible (currently version 2). A mismatch
  pauses useful sync until versions are aligned; changing storage schema needs
  an explicit migration/recovery design.
- Run `npm audit` and tests when updating tooling. Wrangler's workerd/Miniflare
  packages must stay compatible; do not force an old audit-recommended major
  downgrade without checking its platform support.
- Never expose exception messages, change payloads, book contents, cookies, or
  Access assertions through telemetry. API errors use stable public codes.

History compaction/snapshot bootstrap, server-side account quotas, per-user
rate limiting, multipart uploads, and authenticated remote deletion/retention
are future work. The current log is append-only and remote originals remain
until the operator removes them. Monitor resource usage and keep the Access
policy restricted for the personal deployment.
