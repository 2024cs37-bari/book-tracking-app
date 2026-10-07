# ADR 0002: Data lifecycle and recoverability

- **Status:** Accepted
- **Date:** 2026-10-07
- **Decision owners:** Project maintainer

## Context

The server will hold a durable copy of personal books and metadata, while local browser storage can be cleared or evicted. Deleting a metadata row, evicting a local cache file, archiving a book, and permanently deleting a remote original have different consequences and must not share ambiguous UI behavior.

## Decisions

1. Identify original book bytes by lowercase SHA-256 and store them unmodified.
2. Treat local metadata as the immediate UI source of truth; synchronize changes asynchronously.
3. Make **archive** the reversible default for removing an item from normal views.
4. Represent synchronized metadata deletion as a **tombstone**; do not hard-delete on ordinary sync.
5. Make removal of the remote original a separate, explicit, confirmed action. It is never implied by archive, local cache eviction, or metadata tombstone.
6. Keep pinning, file presence, LRU timestamps, and transfer queues local to each device.
7. Provide manual metadata/annotation export and a path to export original files before production sync is considered complete.
8. Defer irreversible purge and automated garbage collection until retention, restore, and reference rules are tested.

## Rationale

This separates recoverability from cache management and protects data from an accidental UI action, stale device, or synchronization bug. Content addressing deduplicates identical files and makes integrity checks deterministic. Device-local cache policy must not conflict between a phone and desktop.

## Consequences

- Tombstones and change history require a retention/compaction policy.
- Permanent object deletion needs an explicit confirmation flow and authorization checks.
- Re-importing identical bytes must merge metadata carefully rather than replacing user edits with empty extraction results.
- Exports and restore validation are release requirements, not optional polish.
- Cloud copies are private but not end-to-end encrypted under the initial baseline.

## Revisit when

- A retention policy is defined and tested against multi-device/offline restore scenarios.
- User research demonstrates that archive-first behavior is confusing.
- End-to-end encryption is required and a viable key recovery strategy is designed.
