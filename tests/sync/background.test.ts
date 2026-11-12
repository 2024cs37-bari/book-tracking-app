import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { FileTransferRepository } from '~/data/repositories/file-transfer-repository';
import { BackgroundSync } from '~/sync/background';
import { SyncHttpError } from '~/sync/http-transport';
import { bookFileKey } from '~/storage/file-store';

let h: TestHarness;
let background: BackgroundSync;
let calls: number;
let behavior: () => Promise<void>;
let online: boolean;
let transfers: FileTransferRepository;
async function settle() {
  for (let i = 0; i < 30; i++) await nextTurn();
}
beforeEach(async () => {
  h = await createHarness({ startTime: 10_000 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(10_000);
  transfers = new FileTransferRepository(h.db);
  online = true;
  calls = 0;
  behavior = async () => {};
  background = new BackgroundSync({
    db: h.db,
    transfers,
    files: h.files,
    online: () => online,
    random: () => 0.5,
    sync: {
      sync: async () => {
        calls++;
        await behavior();
        return { pushed: 0, applied: 0, caughtUp: true, bootstrapped: false };
      },
    },
    transfer: { run: async () => ({ uploaded: 0, downloaded: 0, failed: 0, cancelled: 0 }) },
  });
});
afterEach(async () => {
  background.stop();
  await settle();
  vi.useRealTimers();
  await h.close();
});
async function start() {
  background.start();
  await settle();
  await background.retryNow();
  await settle();
}

describe('BackgroundSync', () => {
  it('honors Retry-After even when local writes arrive during backoff', async () => {
    behavior = async () => {
      throw new SyncHttpError('rate limit', { retryable: true, retryAfterMs: 30_000 });
    };
    await start();
    const before = calls;
    expect(background.getStatus().nextAttemptAt).toBe(40_000);
    await h.shelves.create('Local write remains usable');
    await settle();
    background.requestSync();
    await vi.advanceTimersByTimeAsync(29_999);
    await settle();
    expect(calls).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(calls).toBe(before + 1);
    expect(await h.shelves.list()).toHaveLength(1);
  });
  it('pauses on authentication failure until explicit retry', async () => {
    behavior = async () => {
      throw new SyncHttpError('sign in', { retryable: false, authExpired: true });
    };
    await start();
    expect(background.getStatus().state).toBe('auth-required');
    const before = calls;
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();
    background.requestSync();
    expect(calls).toBe(before);
    behavior = async () => {};
    await background.retryNow();
    expect(calls).toBe(before + 1);
    expect(background.getStatus().lastSuccessAt).toBeDefined();
  });
  it('does not run offline, and an online trigger resumes scheduling', async () => {
    online = false;
    await start();
    expect(calls).toBe(0);
    expect(background.getStatus().state).toBe('offline');
    online = true;
    background.requestSync();
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    expect(calls).toBe(1);
  });
  it('discovers local originals without downloading remote-only books or resetting failed upload retries', async () => {
    const local = 'a'.repeat(64),
      remote = 'b'.repeat(64);
    await h.db.books.bulkPut(
      [local, remote].map((sha256, i) => ({
        id: `b${i}`,
        sha256,
        title: 'T',
        format: 'epub' as const,
        sizeBytes: 3,
        metadataIncomplete: false,
        lifecycle: 'active' as const,
        addedAt: 1,
        updatedHlc: '1:0:d',
      })),
    );
    await h.files.put(bookFileKey(local), new Blob(['abc']));
    const job = await transfers.enqueueUpload(local);
    await transfers.markFailed(job.id, 60_000, { error: 'slow', retryable: true });
    background.start();
    await settle();
    await vi.advanceTimersByTimeAsync(750);
    await settle();
    const jobs = await transfers.listAll();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe('failed');
    expect(jobs[0]?.retryAfter).toBe(70_000);
  });
  it('coalesces concurrent manual requests into a single flight', async () => {
    background.start();
    await settle();
    let resolve!: () => void;
    behavior = () =>
      new Promise<void>((done) => {
        resolve = done;
      });
    const first = background.retryNow();
    await settle();
    for (let i = 0; i < 500 && calls === 0; i++) await nextTurn();
    const before = calls;
    const second = background.retryNow();
    await settle();
    expect(calls).toBe(before);
    resolve();
    await Promise.all([first, second]);
  });
});

describe('background preferences and diagnostics', () => {
  it('restores the paused preference and last success without issuing network work', async () => {
    await h.db.syncMeta.bulkPut([
      { key: 'background_paused', value: 'true' },
      { key: 'background_last_success', value: '1234' },
    ]);
    background.start();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(calls).toBe(0);
    expect(background.getStatus()).toMatchObject({ state: 'paused', lastSuccessAt: 1234 });
  });
  it('keeps a pause made during network work when the current cycle finishes', async () => {
    background.start();
    await settle();
    let resolve!: () => void;
    behavior = () =>
      new Promise<void>((done) => {
        resolve = done;
      });
    const running = background.retryNow();
    for (let i = 0; i < 1000 && calls === 0; i++) await nextTurn();
    expect(calls).toBe(1);
    background.pause();
    resolve();
    await running;
    expect(background.getStatus().state).toBe('paused');
    expect((await h.db.syncMeta.get('background_paused'))?.value).toBe('true');
  });
});

describe('retry deadline survives connectivity changes', () => {
  it('keeps Retry-After after an offline interval', async () => {
    behavior = async () => {
      throw new SyncHttpError('rate limit', { retryable: true, retryAfterMs: 30_000 });
    };
    await start();
    const before = calls;
    online = false;
    background.requestSync();
    expect(background.getStatus().state).toBe('offline');
    await vi.advanceTimersByTimeAsync(1000);
    online = true;
    background.requestSync();
    await vi.advanceTimersByTimeAsync(28_999);
    await settle();
    expect(calls).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(calls).toBe(before + 1);
  });
});
