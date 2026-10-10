import { assertSha256Hex } from '~/domain/ids';
import type { FileTransferRow, LibraryDatabase, TransferDirection, TransferState } from '../db';

/**
 * Durable local queue of original-file upload/download jobs (STORAGE.md §6).
 *
 * Each job is keyed `${direction}:${sha256}`, which makes enqueueing idempotent
 * and naturally deduplicates by content hash: asking twice to upload the same
 * book reuses the one job. Jobs survive restarts; the transfer engine renews
 * authorization and resumes (or restarts cleanly) from these rows. The queue is
 * local-only — it is never replicated.
 */
export class FileTransferRepository {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private id(direction: TransferDirection, sha256: string): string {
    return `${direction}:${assertSha256Hex(sha256)}`;
  }

  /** Queues an upload for a hash, reviving a previously failed job. Idempotent. */
  async enqueueUpload(sha256: string): Promise<FileTransferRow> {
    return this.enqueue('upload', sha256);
  }

  /** Queues a download for a hash, reviving a previously failed job. Idempotent. */
  async enqueueDownload(sha256: string): Promise<FileTransferRow> {
    return this.enqueue('download', sha256);
  }

  private async enqueue(direction: TransferDirection, sha256: string): Promise<FileTransferRow> {
    const id = this.id(direction, sha256);
    const existing = await this.db.fileTransfers.get(id);
    // A completed job stays completed; an in-flight one is left alone; only a
    // failed job is re-queued so a retry picks it up.
    if (existing !== undefined && existing.state !== 'failed') return existing;
    const row: FileTransferRow = {
      id,
      sha256: assertSha256Hex(sha256),
      direction,
      state: 'queued',
      bytesDone: 0,
      updatedAt: this.now(),
    };
    await this.db.fileTransfers.put(row);
    return row;
  }

  async get(id: string): Promise<FileTransferRow | undefined> {
    return this.db.fileTransfers.get(id);
  }

  async listAll(): Promise<FileTransferRow[]> {
    return this.db.fileTransfers.toArray();
  }

  /** Jobs still needing work: queued or previously failed, oldest first. */
  async listPending(): Promise<FileTransferRow[]> {
    const rows = await this.db.fileTransfers.toArray();
    return rows
      .filter((row) => row.state === 'queued' || row.state === 'failed')
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }

  /**
   * Returns any job stuck in `running` to `queued`. A `running` row with no live
   * worker is the sign of a crash mid-transfer; the baseline restarts it
   * cleanly rather than resuming partial single-PUT bytes.
   */
  async recoverRunning(): Promise<void> {
    const stuck = await this.db.fileTransfers.where('state').equals('running').toArray();
    for (const row of stuck) {
      await this.db.fileTransfers.put({
        ...row,
        state: 'queued',
        bytesDone: 0,
        updatedAt: this.now(),
      });
    }
  }

  private async patch(id: string, patch: Partial<FileTransferRow>): Promise<void> {
    const row = await this.db.fileTransfers.get(id);
    if (row === undefined) return;
    await this.db.fileTransfers.put({ ...row, ...patch, updatedAt: this.now() });
  }

  async setState(id: string, state: TransferState): Promise<void> {
    await this.patch(id, { state });
  }

  async setBytesDone(id: string, bytesDone: number): Promise<void> {
    await this.patch(id, { bytesDone });
  }

  async markFailed(id: string, retryAfterMs?: number): Promise<void> {
    await this.patch(
      id,
      retryAfterMs === undefined
        ? { state: 'failed' }
        : { state: 'failed', retryAfter: this.now() + retryAfterMs },
    );
  }

  async markComplete(id: string, bytesDone: number): Promise<void> {
    await this.patch(id, { state: 'complete', bytesDone });
  }

  async remove(id: string): Promise<void> {
    await this.db.fileTransfers.delete(id);
  }
}
