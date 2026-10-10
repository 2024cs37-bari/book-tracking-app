import { verifySha256 } from '~/storage/sha256';
import { bookFileKey, type BookFileStore } from '~/storage/file-store';
import type { BookRepository } from '~/data/repositories/book-repository';
import type { DeviceStateRepository } from '~/data/repositories/device-state-repository';
import type { FileTransferRepository } from '~/data/repositories/file-transfer-repository';
import type { FileTransferRow } from '~/data/db';
import type { FileTransport } from './transport';

export interface FileTransferResult {
  /** Objects uploaded (or confirmed already-available) this cycle. */
  readonly uploaded: number;
  /** Objects downloaded (or confirmed already-local) this cycle. */
  readonly downloaded: number;
  /** Jobs that failed this cycle and remain queued for a later retry. */
  readonly failed: number;
}

export interface FileTransferEngineOptions {
  readonly transfers: FileTransferRepository;
  readonly files: BookFileStore;
  readonly books: BookRepository;
  readonly deviceState: DeviceStateRepository;
  readonly transport: FileTransport;
  /** Bounded parallel transfers (STORAGE.md §6). */
  readonly concurrency?: number;
  readonly now?: () => number;
}

/**
 * Drives the durable file-transfer queue (docs/BACKEND.md §6, STORAGE.md §6).
 *
 * Books' bytes move directly between this device and private R2, never through
 * the metadata sync protocol. The engine is single-flight (a concurrent call
 * joins the running cycle), processes jobs with bounded concurrency, and is
 * safe to re-run: an upload deduplicates by hash, a download that is already
 * local is a no-op, and a download whose bytes fail SHA-256 verification is
 * rejected without being written. Local presence is published through
 * device-state only after a verified download.
 */
export class FileTransferEngine {
  private readonly options: Required<Omit<FileTransferEngineOptions, 'now'>> &
    Pick<FileTransferEngineOptions, 'now'>;
  private readonly now: () => number;
  private inFlight?: Promise<FileTransferResult>;

  constructor(options: FileTransferEngineOptions) {
    this.options = { concurrency: 2, now: options.now, ...options };
    this.now = options.now ?? (() => Date.now());
  }

  run(): Promise<FileTransferResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.drain().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async drain(): Promise<FileTransferResult> {
    // A job left `running` by a crash is restarted cleanly.
    await this.options.transfers.recoverRunning();
    const pending = await this.options.transfers.listPending();
    const nowMs = this.now();
    // Honour backoff on previously-failed jobs.
    const queue = pending.filter(
      (row) => row.state === 'queued' || row.retryAfter === undefined || row.retryAfter <= nowMs,
    );
    const result = { uploaded: 0, downloaded: 0, failed: 0 };

    const worker = async (): Promise<void> => {
      for (;;) {
        const row = queue.shift();
        if (row === undefined) break;
        const outcome = await this.processOne(row);
        result[outcome] += 1;
      }
    };
    const workerCount = Math.max(1, Math.min(this.options.concurrency, queue.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return result;
  }

  private async processOne(row: FileTransferRow): Promise<'uploaded' | 'downloaded' | 'failed'> {
    try {
      await this.options.transfers.setState(row.id, 'running');
      return row.direction === 'upload'
        ? await this.processUpload(row)
        : await this.processDownload(row);
    } catch {
      // A transfer failure is retryable: leave the job queued (failed) for a
      // later cycle rather than losing it. The error surfaces via job state.
      await this.options.transfers.markFailed(row.id);
      return 'failed';
    }
  }

  private async processUpload(row: FileTransferRow): Promise<'uploaded' | 'failed'> {
    const key = bookFileKey(row.sha256);
    if (!(await this.options.files.has(key))) {
      // Cannot upload bytes this device does not hold; fail visibly.
      await this.options.transfers.markFailed(row.id);
      return 'failed';
    }
    const blob = await this.options.files.get(key);
    const auth = await this.options.transport.beginUpload(row.sha256, blob.size);
    if (!auth.alreadyAvailable) {
      if (auth.ticket === undefined) throw new Error('Upload authorization carried no ticket.');
      await this.options.transport.upload(auth.ticket, blob);
    }
    // The server verifies and only then publishes availability.
    await this.options.transport.finishUpload(row.sha256, blob.size);
    await this.options.transfers.markComplete(row.id, blob.size);
    return 'uploaded';
  }

  private async processDownload(row: FileTransferRow): Promise<'downloaded' | 'failed'> {
    const key = bookFileKey(row.sha256);
    if (await this.options.files.has(key)) {
      // Already present: confirm presence and finish without a network fetch.
      const existing = await this.options.files.get(key);
      await this.markPresent(row.sha256);
      await this.options.transfers.markComplete(row.id, existing.size);
      return 'downloaded';
    }
    const ticket = await this.options.transport.beginDownload(row.sha256);
    const blob = await this.options.transport.download(ticket);
    // Never trust downloaded bytes: a hash mismatch is rejected, not written.
    if (!(await verifySha256(blob, row.sha256))) {
      await this.options.transfers.markFailed(row.id);
      return 'failed';
    }
    await this.options.files.put(key, blob);
    await this.markPresent(row.sha256);
    await this.options.transfers.markComplete(row.id, blob.size);
    return 'downloaded';
  }

  /** Marks the book owning this hash present locally, if one is known. */
  private async markPresent(sha256: string): Promise<void> {
    const book = await this.options.books.findBySha256(sha256);
    if (book !== undefined) await this.options.deviceState.setFilePresent(book.id, true);
  }
}
