import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { DiagnosticsService, DIAGNOSTICS_FORMAT } from '~/services/diagnostics-service';
import type { BackgroundStatus } from '~/sync/background';

let h: TestHarness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});
const PRIVATE = 'PRIVATE-DO-NOT-EXPORT-78219';
const SHA = 'de'.repeat(32);
function service(status?: BackgroundStatus) {
  return new DiagnosticsService({
    db: h.db,
    files: h.files,
    persistentStorage: null,
    syncConfigured: status !== undefined,
    syncStatus: () => status!,
    now: () => Date.UTC(2026, 10, 7),
  });
}
async function seedPrivateData() {
  await h.db.books.put({
    id: `id-${PRIVATE}`,
    sha256: SHA,
    title: `title-${PRIVATE}`,
    author: `author-${PRIVATE}`,
    format: 'epub',
    sizeBytes: 1234,
    coverKey: `filename-${PRIVATE}.jpg`,
    metadataIncomplete: false,
    lifecycle: 'active',
    addedAt: 1,
    updatedHlc: `1:0:device-${PRIVATE}`,
  });
  await h.db.changes.put({
    id: `change-${PRIVATE}`,
    entity: 'book',
    entityId: `id-${PRIVATE}`,
    op: 'upsert',
    payload: JSON.stringify({
      secret: PRIVATE,
      url: `https://${PRIVATE}.example/api?token=${PRIVATE}`,
    }),
    hlc: `1:0:device-${PRIVATE}`,
    deviceId: `device-${PRIVATE}`,
    createdAt: 1,
    pushedAt: 0,
  });
  await h.db.fileTransfers.put({
    id: `upload:${SHA}`,
    sha256: SHA,
    direction: 'upload',
    state: 'failed',
    bytesDone: 0,
    updatedAt: 1,
    error: `Authorization failed: https://${PRIVATE}.example/token`,
    retryable: false,
  });
  await h.db.annotations.put({
    id: `note-${PRIVATE}`,
    bookId: `id-${PRIVATE}`,
    kind: 'note',
    locatorKind: 'cfi',
    locatorValue: `epubcfi(${PRIVATE})`,
    fraction: 0.1,
    note: `content-${PRIVATE}`,
    createdHlc: '1:0:device',
    updatedHlc: '1:0:device',
    deleted: false,
  });
  await h.db.syncMeta.bulkPut([
    { key: 'device_id', value: `user-${PRIVATE}` },
    { key: 'sync_server_url', value: `https://${PRIVATE}.example/api?token=${PRIVATE}` },
    { key: 'background_last_success', value: String(Date.UTC(2026, 10, 6)) },
  ]);
}

describe('privacy-preserving diagnostics', () => {
  it('exports only allowlisted counts and coarse health information despite distinctive private records', async () => {
    await seedPrivateData();
    vi.spyOn(h.files, 'estimate').mockResolvedValue({
      usageBytes: 1234567,
      quotaBytes: 23456789,
      persisted: true,
    });
    const report = await service({
      state: 'error',
      error: `raw-error-${PRIVATE}`,
      nextAttemptAt: Date.now(),
      lastSuccessAt: Date.UTC(2026, 10, 6),
    }).capture();
    const json = JSON.stringify(report);
    expect(json).not.toContain(PRIVATE);
    expect(json).not.toContain(SHA);
    expect(json).not.toContain('https:');
    expect(Object.keys(report).sort()).toEqual([
      'app',
      'format',
      'generatedAt',
      'library',
      'storage',
      'sync',
      'version',
    ]);
    expect(report.format).toBe(DIAGNOSTICS_FORMAT);
    expect(report.library.books).toEqual({ active: 1, archived: 0, deleted: 0, total: 1 });
    expect(report.library.outbox).toEqual({ pending: 1, total: 1 });
    expect(report.library.transfers).toEqual({
      queued: 0,
      running: 0,
      failed: 1,
      complete: 0,
      cancelled: 0,
    });
    expect(report.storage).toEqual({
      backend: 'memory',
      durable: false,
      persistenceGranted: true,
      usageMiB: 2,
      quotaMiB: 23,
      estimateAvailable: true,
    });
    expect(report.sync).toEqual({
      configured: true,
      state: 'error',
      lastMetadataSuccessAt: '2026-11-06T00:00:00.000Z',
    });
    expect(Object.keys(report.app).sort()).toEqual([
      'buildMode',
      'localSchema',
      'version',
      'wireSchema',
    ]);
  });
  it('produces a JSON Blob without modifying local data or creating sync work', async () => {
    await seedPrivateData();
    const before = await h.db.changes.toArray();
    const blob = await service().blob();
    expect(blob.type).toBe('application/json');
    const report = JSON.parse(await blob.text());
    expect(report.sync.state).toBe('disabled');
    expect(await h.db.changes.toArray()).toEqual(before);
  });
  it('reports an unavailable estimate without including its raw exception', async () => {
    vi.spyOn(h.files, 'estimate').mockRejectedValue(new Error(`secret storage path ${PRIVATE}`));
    await h.db.syncMeta.put({ key: 'background_last_success', value: `secret-${PRIVATE}` });
    const report = await service().capture();
    expect(report.storage.estimateAvailable).toBe(false);
    expect(report.storage.usageMiB).toBeNull();
    expect(report.storage.quotaMiB).toBeNull();
    expect(report.sync.lastMetadataSuccessAt).toBeNull();
    expect(JSON.stringify(report)).not.toContain(PRIVATE);
  });
});
