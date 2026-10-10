import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { FileTransferRepository } from '~/data/repositories/file-transfer-repository';

let harness: TestHarness;
let repo: FileTransferRepository;
let clock: number;

beforeEach(async () => {
  harness = await createHarness();
  clock = 1_000;
  repo = new FileTransferRepository(harness.db, () => clock);
});
afterEach(async () => {
  await harness.close();
});

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('FileTransferRepository', () => {
  it('enqueues idempotently, deduplicated by direction and hash', async () => {
    const first = await repo.enqueueUpload(SHA_A);
    const second = await repo.enqueueUpload(SHA_A);
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(`upload:${SHA_A}`);
    expect((await repo.listAll()).length).toBe(1);
    // Upload and download of the same hash are distinct jobs.
    await repo.enqueueDownload(SHA_A);
    expect((await repo.listAll()).length).toBe(2);
  });

  it('revives a failed job on re-enqueue', async () => {
    const job = await repo.enqueueUpload(SHA_A);
    await repo.markFailed(job.id);
    expect((await repo.get(job.id))?.state).toBe('failed');
    const revived = await repo.enqueueUpload(SHA_A);
    expect(revived.state).toBe('queued');
  });

  it('leaves a completed job completed on re-enqueue', async () => {
    const job = await repo.enqueueDownload(SHA_A);
    await repo.markComplete(job.id, 100);
    const again = await repo.enqueueDownload(SHA_A);
    expect(again.state).toBe('complete');
  });

  it('lists pending (queued or failed) oldest first', async () => {
    clock = 10;
    await repo.enqueueUpload(SHA_A);
    clock = 20;
    const b = await repo.enqueueUpload(SHA_B);
    await repo.markFailed(b.id);
    clock = 30;
    const pending = await repo.listPending();
    expect(pending.map((row) => row.sha256)).toEqual([SHA_A, SHA_B]);
  });

  it('recovers a crashed running job back to queued', async () => {
    const job = await repo.enqueueUpload(SHA_A);
    await repo.setState(job.id, 'running');
    await repo.recoverRunning();
    const recovered = await repo.get(job.id);
    expect(recovered?.state).toBe('queued');
    expect(recovered?.bytesDone).toBe(0);
  });

  it('records a retry-after when failing with backoff', async () => {
    clock = 1_000;
    const job = await repo.enqueueDownload(SHA_A);
    await repo.markFailed(job.id, 5_000);
    expect((await repo.get(job.id))?.retryAfter).toBe(6_000);
  });
});
