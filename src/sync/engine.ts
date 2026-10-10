import type { Clock } from '~/domain/hlc';
import type { LibraryDatabase } from '~/data/db';
import type { ChangeRepository } from '~/data/repositories/change-repository';
import type { SyncMetaRepository } from '~/data/repositories/sync-meta-repository';
import { applyPullPage } from './apply';
import { buildPushRequest } from './protocol';
import type { SyncTransport } from './transport';

export interface SyncResult {
  /** Outbox rows the server acknowledged this cycle. */
  readonly pushed: number;
  /** Remote changes applied locally this cycle. */
  readonly applied: number;
  /** True when the pull caught up to the server (no more pages). */
  readonly caughtUp: boolean;
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
      maxPages: 10_000,
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
    const pushed = await this.pushOutbox();
    const { applied, caughtUp } = await this.pullAndApply();
    if (this.options.persistClock) await this.options.persistClock();
    return { pushed, applied, caughtUp };
  }

  private async pushOutbox(): Promise<number> {
    let pushed = 0;
    for (;;) {
      const batch = await this.options.changes.listPending(this.options.pushBatchSize);
      if (batch.length === 0) break;
      const response = await this.options.transport.push(
        buildPushRequest(this.options.deviceId, batch),
      );
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
      if (acknowledged.length < batch.length) break;
    }
    return pushed;
  }

  private async pullAndApply(): Promise<{ applied: number; caughtUp: boolean }> {
    let applied = 0;
    for (let page = 0; page < this.options.maxPages; page += 1) {
      const since = await this.options.syncMeta.getPullCursor();
      const response = await this.options.transport.pull(since, this.options.pullLimit);
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
