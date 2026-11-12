# Contributing

Personal Book Reader contains a SolidJS web client, a separately deployed Cloudflare Worker,
local persistence, reader adapters and automated regression suites. Documentation describes both
implemented behavior and explicitly deferred capabilities; keep that distinction intact.

## Before proposing a change

- Read the [README](README.md), [Product requirements](docs/PRODUCT.md), and the relevant architecture/data/sync document.
- Check existing [decision records](docs/decisions/) before proposing a different technology or lifecycle behavior.
- Keep scope focused. If behavior changes, update the acceptance criteria, data model, sync contract, security considerations, and roadmap as applicable.
- Preserve the initial requirements in `docs/archive/`; do not edit that historical snapshot to make it look like the current specification.

## Documentation changes

- Use descriptive headings and tables only where they make comparisons easier to scan.
- Define specialized terms at first use and use them consistently.
- Separate committed decisions from assumptions and validation tasks.
- Prefer testable acceptance criteria over unqualified claims such as “fast,” “secure,” or “supports all files.”
- Check relative Markdown links and ensure examples agree across documents.

## Pull requests

A pull request should explain the user or maintenance need, summarize the design, identify affected docs/data/API contracts, and list validation performed. Do not include copyrighted books, credentials, private Access headers, signed URLs, or personal library data.

## Code standards

Install both packages with `npm ci` and `npm ci --prefix server`, then run `npm run check:all`.
It checks frontend types, lint, formatting, local documentation links, unit tests and build, followed by server types and local
Worker tests. Use `npm run test:browser` for user-flow changes and `npm run test:sync-browser` for
transport/convergence changes. Renderer changes also require the pinned corpus suite; acquisition
is explicit through `npm run corpus:fetch`. Record unavailable engines or external sources rather
than weakening assertions. CI separates client, server and corpus jobs.

Requirements for new code:

- Respect the layer direction: `domain` has no dependencies; `data`, `storage` and `reader` may depend
  on `domain`; `services` orchestrates them; `ui` renders and must not import Dexie, OPFS or `fetch`
  directly.
- Keep UI separate from domain behavior and storage/network adapters.
- Validate external data at boundaries and handle offline/error states explicitly.
- Add tests for domain rules, persistence atomicity and import/format behavior. Tests run in Node with
  `fake-indexeddb`, so use the harness in `tests/support/harness.ts` rather than mocking Dexie.
- Generate targeted fixtures in memory (`tests/support/fixtures.ts`). Keep real books outside the
  repository; the external corpus has explicit provenance, licensing and pinned hashes. Never
  commit private books. See `docs/READER-VALIDATION.md` before adding an upstream sample.
- Avoid logging user book content or credentials.
- Include migrations, tests, and recovery behavior for persisted data changes. Never edit a released
  Dexie schema version; add a new one.
- Document supported formats against evidence, not package names. Importing a format and rendering it
  reliably are separate claims.

## License

The repository currently has no license. Until one is chosen and added, no contribution is assumed to be offered under an open-source license. Please discuss licensing before contributing substantial code.
