import type { SessionRepository } from '~/data/repositories/session-repository';
import type { NewReadingSession } from '~/domain/session';

export const READING_CHECKPOINT_MS = 60_000;
export const MIN_READING_SPAN_SECONDS = 5;

/** A failed statistics write stays queued across reader navigation in this app. */
export class ReadingActivityQueue {
  private readonly pending: NewReadingSession[] = [];
  private writes = Promise.resolve();
  private clockDirty = false;
  constructor(
    private readonly record: (span: NewReadingSession) => Promise<unknown>,
    private readonly persistClock: () => Promise<void>,
  ) {}
  enqueue(span: NewReadingSession): void {
    this.pending.push(span);
  }
  flush(report: (error: string | null) => void): Promise<void> {
    this.writes = this.writes.then(async () => {
      try {
        while (this.pending.length) {
          await this.record(this.pending[0]!);
          // Remove only after durable record commit; clock persistence retries
          // must not create a duplicate append-only reading session.
          this.pending.shift();
          this.clockDirty = true;
        }
        if (this.clockDirty) {
          await this.persistClock();
          this.clockDirty = false;
        }
        report(null);
      } catch (error) {
        report(
          `Reading time could not be saved: ${String(error)}. It is retained for retry while this app remains open.`,
        );
      }
    });
    return this.writes;
  }
}

const queues = new WeakMap<SessionRepository, ReadingActivityQueue>();
export function readingActivityQueue(
  repository: SessionRepository,
  persistClock: () => Promise<void>,
): ReadingActivityQueue {
  let queue = queues.get(repository);
  if (!queue) {
    queue = new ReadingActivityQueue((span) => repository.record(span), persistClock);
    queues.set(repository, queue);
  }
  return queue;
}

/** Monotonic foreground spans; pause/cleanup can run repeatedly without duplication. */
export class ReadingActivity {
  private active?: { startedAt: number; monotonicAt: number; fraction: number };
  constructor(
    private readonly bookId: string,
    private readonly queue: ReadingActivityQueue,
    private readonly report: (error: string | null) => void,
    private readonly now = () => Date.now(),
    private readonly monotonic = () => performance.now(),
  ) {}
  resume(fraction: number): void {
    this.active ??= { startedAt: this.now(), monotonicAt: this.monotonic(), fraction };
    void this.queue.flush(this.report);
  }
  pause(fraction: number): Promise<void> {
    const span = this.active;
    this.active = undefined;
    if (span) {
      const durationS = Math.max(0, Math.floor((this.monotonic() - span.monotonicAt) / 1000));
      if (durationS >= MIN_READING_SPAN_SECONDS)
        this.queue.enqueue({
          bookId: this.bookId,
          startedAt: span.startedAt,
          durationS,
          startFraction: span.fraction,
          endFraction: fraction,
        });
    }
    return this.queue.flush(this.report);
  }
  checkpoint(fraction: number): Promise<void> {
    const wasActive = this.active !== undefined;
    const write = this.pause(fraction);
    if (wasActive) this.resume(fraction);
    return write;
  }
  retry(): Promise<void> {
    return this.queue.flush(this.report);
  }
}
