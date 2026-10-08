# Contributing

Thank you for helping improve Personal Book Reader. The repository is documentation-first; no application runtime or automated checks have been scaffolded yet.

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

Run `npm run check` before opening a pull request; it type-checks, lints, verifies formatting, runs the
tests and builds. CI runs the same command.

Requirements for new code:

- Respect the layer direction: `domain` has no dependencies; `data`, `storage` and `reader` may depend
  on `domain`; `services` orchestrates them; `ui` renders and must not import Dexie, OPFS or `fetch`
  directly.
- Keep UI separate from domain behavior and storage/network adapters.
- Validate external data at boundaries and handle offline/error states explicitly.
- Add tests for domain rules, persistence atomicity and import/format behavior. Tests run in Node with
  `fake-indexeddb`, so use the harness in `tests/support/harness.ts` rather than mocking Dexie.
- Generate test fixtures in memory (`tests/support/fixtures.ts`). Never commit book files: they cannot
  be licensed for redistribution, and generated fixtures make the tested detail explicit.
- Avoid logging user book content or credentials.
- Include migrations, tests, and recovery behavior for persisted data changes. Never edit a released
  Dexie schema version; add a new one.
- Document supported formats against evidence, not package names. Importing a format and rendering it
  reliably are separate claims.

## License

The repository currently has no license. Until one is chosen and added, no contribution is assumed to be offered under an open-source license. Please discuss licensing before contributing substantial code.
