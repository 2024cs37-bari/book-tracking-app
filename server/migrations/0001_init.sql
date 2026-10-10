-- Authoritative sync change log (docs/DATA-MODEL.md §1, docs/SYNC.md §4).
--
-- One row per accepted replicated mutation. `seq` is the global monotonic
-- cursor pull paginates over; `(user_id, change_id)` is unique so a retried
-- push is idempotent (returns `duplicate`, never a second row). Payloads are
-- stored verbatim as the client's canonical JSON and resolved by the client's
-- HLC conflict rules on apply, so the server stays a durable, ordered log and
-- does not interpret entity semantics.

CREATE TABLE IF NOT EXISTS changes (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  change_id  TEXT    NOT NULL,
  entity     TEXT    NOT NULL,
  entity_id  TEXT    NOT NULL,
  op         TEXT    NOT NULL,
  hlc        TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS changes_user_change_id ON changes (user_id, change_id);
CREATE INDEX IF NOT EXISTS changes_user_seq ON changes (user_id, seq);
