import type { Clock } from '~/domain/hlc';
import { DB_SCHEMA_VERSION, type LibraryDatabase } from '~/data/db';
import type { ChangeRepository } from '~/data/repositories/change-repository';
import type { SyncMetaRepository } from '~/data/repositories/sync-meta-repository';
import { SyncHttpError } from './http-transport';
import { applyPullPage } from './apply';
import { buildPushRequest } from './protocol';
import { isCursorExpiredError, type SyncTransport } from './transport';

export interface SyncResult {
  /** Outbox rows the server acknowledged this cycle. */
  readonly pushed: number;
  /** Remote changes applied locally this cycle. */
  readonly applied: number;
  /** True when the pull caught up to the server (no more pages). */
  readonly caughtUp: boolean;
  /**
   * True when the server reported the held cursor expired (SYNC.md §7) and this
   * cycle re-bootstrapped from zero. The caller should not treat a bootstrapped
   * cycle as proof the prior local state was complete.
   */
  readonly bootstrapped: boolean;
}

export interface SyncEngineOptions {
  readonly db: LibraryDatabase;
  readonly changes: ChangeRepository;
  readonly syncMeta: SyncMetaRepository;
  readonly clock: Clock;
  readonly transport: SyncTransport;
  readonly deviceId: string;
  /** Persists the clock so a restart cannot reissue an earlier HLC. */
  readonly persistClock?: () => Promise<void>;
  readonly pushBatchSize?: number;
  readonly pullLimit?: number;
  /** Backstop against a server that never reports caught-up. */
  readonly maxPages?: number;
  readonly maxPushBatches?: number;
}

/**
 * Drives a sync cycle: push the outbox, then pull and apply remote changes
 * (docs/SYNC.md §5). It is single-flight — a concurrent call joins the running
 * cycle rather than starting a second — so overlapping triggers (launch,
 * foreground, debounced progress) cannot race. Remote application never writes
 * the outbox, and the pull cursor only advances with the data it applied.
 */
export class SyncEngine {
  private readonly options: Required<Omit<SyncEngineOptions, 'persistClock'>> &
    Pick<SyncEngineOptions, 'persistClock'>;
  private inFlight?: Promise<SyncResult>;

  constructor(options: SyncEngineOptions) {
    this.options = {
      pushBatchSize: 100,
      pullLimit: 200,
      maxPages: 20,
      maxPushBatches: 10,
      persistClock: options.persistClock,
      ...options,
    };
  }

  sync(): Promise<SyncResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<SyncResult> {
    const { pushed, error } = await this.pushOutbox();
    const { applied, caughtUp, bootstrapped } = await this.pullAndApply();
    if (this.options.persistClock) await this.options.persistClock();
    if (error !== undefined) throw error;
    return { pushed, applied, caughtUp, bootstrapped };
  }

  private async pushOutbox(): Promise<{ pushed: number; error?: SyncHttpError }> {
    let pushed = 0;
    for (let round = 0; round < this.options.maxPushBatches; round += 1) {
      const batch = await this.options.changes.listPending(this.options.pushBatchSize);
      if (batch.length === 0) break;
      const response = await this.options.transport.push(
        buildPushRequest(this.options.deviceId, batch),
      );
      const requested = new Set(batch.map((row) => row.id));
      const answered = new Set(response.outcomes.map((row) => row.id));
      if (
        answered.size !== response.outcomes.length ||
        answered.size !== requested.size ||
        response.outcomes.some((row) => !requested.has(row.id))
      ) {
        throw new SyncHttpError('Server returned mismatched push acknowledgements.', {
          retryable: false,
          code: 'bad_response',
        });
      }
      const acknowledged = response.outcomes
        .filter((outcome) => outcome.status === 'accepted' || outcome.status === 'duplicate')
        .map((outcome) => outcome.id);
      if (acknowledged.length > 0) {
        await this.options.changes.markPushed(acknowledged);
        pushed += acknowledged.length;
      }
      // If the server did not acknowledge the whole batch, the rest is
      // retryable or rejected; stop so a later cycle retries with backoff
      // rather than spinning on the same unacknowledged rows.
      if (acknowledged.length < batch.length) {
        const rejected = response.outcomes.find((row) => row.status === 'rejected');
        return {
          pushed,
          error: new SyncHttpError(
            rejected
              ? `A local change was rejected (${rejected.code ?? 'validation'}). Local data is retained.`
              : 'Some local changes were not accepted yet. Retrying later.',
            { retryable: rejected === undefined, code: rejected?.code },
          ),
        };
      }
    }
    return { pushed };
  }

  private async pullAndApply(): Promise<{
    applied: number;
    caughtUp: boolean;
    bootstrapped: boolean;
  }> {
    let bootstrapped = false;
    for (;;) {
      try {
        const result = await this.pullPages();
        return { ...result, bootstrapped };
      } catch (error) {
        // The server dropped the sequence this device holds (its history was
        // compacted past our cursor). Discard the cursor and re-pull the whole
        // history from zero; apply is idempotent LWW, so replay is safe. Guard
        // against a second expiry so a misbehaving server cannot spin us.
        if (!bootstrapped && isCursorExpiredError(error)) {
          await this.options.syncMeta.setPullCursor(0);
          bootstrapped = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async pullPages(): Promise<{ applied: number; caughtUp: boolean }> {
    let applied = 0;
    for (let page = 0; page < this.options.maxPages; page += 1) {
      const since = await this.options.syncMeta.getPullCursor();
      const response = await this.options.transport.pull(since, this.options.pullLimit);
      if (response.schema_version !== DB_SCHEMA_VERSION) {
        throw new SyncHttpError('Sync server schema does not match this application.', {
          retryable: false,
          code: 'schema_mismatch',
        });
      }
      let previous = since;
      for (const change of response.changes) {
        if (change.seq <= previous || change.seq > response.next_cursor) {
          throw new SyncHttpError('Sync page has invalid sequence ordering.', {
            retryable: false,
            code: 'bad_response',
          });
        }
        previous = change.seq;
      }
      if (response.next_cursor < since || (response.has_more && response.next_cursor <= since)) {
        throw new SyncHttpError('Sync cursor did not advance.', {
          retryable: false,
          code: 'bad_response',
        });
      }
      if (response.changes.length > 0) {
        await applyPullPage(
          this.options.db,
          this.options.syncMeta,
          this.options.clock,
          response.changes,
          response.next_cursor,
        );
        applied += response.changes.length;
      } else if (response.next_cursor > since) {
        // An empty page can still carry the cursor forward (e.g. past compacted
        // sequences); advance it so the next pull does not re-request them.
        await this.options.syncMeta.setPullCursor(response.next_cursor);
      }
      if (!response.has_more) return { applied, caughtUp: true };
    }
    return { applied, caughtUp: false };
  }
}
