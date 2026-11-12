import { assertSha256Hex } from '~/domain/ids';
import type { FileTransferRow, LibraryDatabase, TransferDirection, TransferState } from '../db';

/** Durable, content-addressed jobs. Explicit requests can revive failed/cancelled work. */
export class FileTransferRepository {
  constructor(
    private readonly db: LibraryDatabase,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async enqueueUpload(sha256: string): Promise<FileTransferRow> {
    return this.enqueue('upload', sha256, false);
  }
  async enqueueDownload(sha256: string): Promise<FileTransferRow> {
    return this.enqueue('download', sha256, false);
  }
  /** Automatic discovery never revives failed/cancelled/completed jobs or resets backoff. */
  async ensureUpload(sha256: string): Promise<FileTransferRow> {
    return this.enqueue('upload', sha256, true);
  }

  private async enqueue(
    direction: TransferDirection,
    sha256: string,
    automatic: boolean,
  ): Promise<FileTransferRow> {
    const hash = assertSha256Hex(sha256);
    const id = `${direction}:${hash}`;
    return this.db.transaction('rw', this.db.fileTransfers, async () => {
      const existing = await this.db.fileTransfers.get(id);
      if (
        existing !== undefined &&
        (automatic ||
          existing.state === 'running' ||
          existing.state === 'queued' ||
          (direction === 'upload' && existing.state === 'complete'))
      )
        return existing;
      const row: FileTransferRow = {
        id,
        sha256: hash,
        direction,
        state: 'queued',
        bytesDone: 0,
        updatedAt: this.now(),
      };
      await this.db.fileTransfers.put(row);
      return row;
    });
  }

  async get(id: string): Promise<FileTransferRow | undefined> {
    return this.db.fileTransfers.get(id);
  }
  async listAll(): Promise<FileTransferRow[]> {
    return this.db.fileTransfers.toArray();
  }
  async listPending(): Promise<FileTransferRow[]> {
    return (await this.listAll())
      .filter((row) => row.state === 'queued' || row.state === 'failed')
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }
  async recoverRunning(): Promise<void> {
    await this.db.fileTransfers
      .where('state')
      .equals('running')
      .modify({ state: 'queued', bytesDone: 0, updatedAt: this.now() });
  }
  private async patch(id: string, patch: Partial<FileTransferRow>): Promise<void> {
    await this.db.fileTransfers.update(id, { ...patch, updatedAt: this.now() });
  }
  async setState(id: string, state: TransferState): Promise<void> {
    await this.patch(id, { state });
  }
  async setBytesDone(id: string, bytesDone: number): Promise<void> {
    await this.patch(id, { bytesDone });
  }
  async markFailed(
    id: string,
    retryAfterMs?: number,
    details: { error?: string; retryable?: boolean; authExpired?: boolean } = {},
  ): Promise<void> {
    await this.db.transaction('rw', this.db.fileTransfers, async () => {
      const row = await this.get(id);
      if (!row || row.state === 'cancelled') return;
      await this.patch(id, {
        state: 'failed',
        attempts: (row.attempts ?? 0) + 1,
        retryAfter: retryAfterMs === undefined ? undefined : this.now() + retryAfterMs,
        ...details,
      });
    });
  }
  async markComplete(id: string, bytesDone: number): Promise<void> {
    await this.db.transaction('rw', this.db.fileTransfers, async () => {
      const row = await this.get(id);
      if (!row || row.state === 'cancelled') return;
      await this.patch(id, {
        state: 'complete',
        bytesDone,
        error: undefined,
        retryAfter: undefined,
        retryable: undefined,
        authExpired: undefined,
      });
    });
  }
  async cancel(id: string): Promise<void> {
    await this.patch(id, { state: 'cancelled', retryAfter: undefined, error: 'Cancelled.' });
  }
  async retryFailed(): Promise<void> {
    await this.db.fileTransfers.where('state').equals('failed').modify({
      state: 'queued',
      retryAfter: undefined,
      error: undefined,
      retryable: undefined,
      authExpired: undefined,
    });
  }
  async remove(id: string): Promise<void> {
    await this.db.fileTransfers.delete(id);
  }
}
