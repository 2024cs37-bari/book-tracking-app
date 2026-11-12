import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness } from '../support/harness';
import { FileTransferRepository } from '~/data/repositories/file-transfer-repository';
import { FileTransferEngine } from '~/transfer/engine';
import type { FileTransport, TransferTicket, UploadAuthorization } from '~/transfer/transport';
import { bookFileKey } from '~/storage/file-store';
import { sha256Blob } from '~/storage/sha256';
import type { BookRow } from '~/data/db';

/** In-memory stand-in for the Worker + private R2: objects keyed by hash. */
class FakeR2 implements FileTransport {
  readonly objects = new Map<string, Blob>();
  uploadCalls = 0;
  finishCalls = 0;

  async beginUpload(sha256: string): Promise<UploadAuthorization> {
    if (this.objects.has(sha256)) return { alreadyAvailable: true };
    return { alreadyAvailable: false, ticket: { url: sha256 } };
  }
  async upload(ticket: TransferTicket, body: Blob): Promise<void> {
    this.uploadCalls += 1;
    this.objects.set(ticket.url, body);
  }
  async finishUpload(sha256: string): Promise<void> {
    this.finishCalls += 1;
    if (!this.objects.has(sha256)) throw new Error('finishUpload before the object exists');
  }
  async beginDownload(sha256: string): Promise<TransferTicket> {
    if (!this.objects.has(sha256)) throw new Error('no such object');
    return { url: sha256 };
  }
  async download(ticket: TransferTicket): Promise<Blob> {
    const object = this.objects.get(ticket.url);
    if (object === undefined) throw new Error('no such object');
    return object;
  }
}

let harness: TestHarness;
let transfers: FileTransferRepository;
let server: FakeR2;

beforeEach(async () => {
  harness = await createHarness();
  transfers = new FileTransferRepository(harness.db);
  server = new FakeR2();
});
afterEach(async () => {
  await harness.close();
});

function engineWith(transport: FileTransport): FileTransferEngine {
  return new FileTransferEngine({
    transfers,
    files: harness.files,
    books: harness.books,
    deviceState: harness.deviceState,
    transport,
    concurrency: 3,
  });
}

/** Registers a book row for a hash so file presence can be attributed to it. */
async function seedBook(sha256: string, id: string, sizeBytes: number): Promise<void> {
  const row: BookRow = {
    id,
    sha256,
    title: id,
    format: 'epub',
    sizeBytes,
    metadataIncomplete: false,
    lifecycle: 'active',
    addedAt: 1,
    updatedHlc: '1:0:device',
  };
  await harness.db.books.put(row);
}

async function makeBlob(text: string): Promise<{ blob: Blob; sha: string }> {
  const blob = new Blob([new TextEncoder().encode(text)]);
  return { blob, sha: await sha256Blob(blob) };
}

describe('FileTransferEngine', () => {
  it('uploads a locally-held file to the server and completes the job', async () => {
    const { blob, sha } = await makeBlob('book-one-bytes');
    await seedBook(sha, 'b1', blob.size);
    await harness.files.put(bookFileKey(sha), blob);
    await transfers.enqueueUpload(sha);

    const result = await engineWith(server).run();

    expect(result.uploaded).toBe(1);
    expect(server.objects.has(sha)).toBe(true);
    expect(server.uploadCalls).toBe(1);
    expect((await transfers.get(`upload:${sha}`))?.state).toBe('complete');
  });

  it('deduplicates: an already-available object is confirmed without re-sending bytes', async () => {
    const { blob, sha } = await makeBlob('already-there');
    await seedBook(sha, 'b1', blob.size);
    await harness.files.put(bookFileKey(sha), blob);
    server.objects.set(sha, blob); // the server already holds it
    await transfers.enqueueUpload(sha);

    const result = await engineWith(server).run();

    expect(result.uploaded).toBe(1);
    expect(server.uploadCalls).toBe(0);
    expect(server.finishCalls).toBe(1);
  });

  it('fails an upload when the bytes are not held locally', async () => {
    const { sha, blob } = await makeBlob('missing-local');
    await seedBook(sha, 'b1', blob.size);
    await transfers.enqueueUpload(sha);

    const result = await engineWith(server).run();

    expect(result.failed).toBe(1);
    expect(server.objects.has(sha)).toBe(false);
    expect((await transfers.get(`upload:${sha}`))?.state).toBe('failed');
  });

  it('downloads, verifies, stores, and marks the book present locally', async () => {
    const { blob, sha } = await makeBlob('remote-only-book');
    await seedBook(sha, 'b2', blob.size);
    server.objects.set(sha, blob);
    await transfers.enqueueDownload(sha);

    const result = await engineWith(server).run();

    expect(result.downloaded).toBe(1);
    expect(await harness.files.has(bookFileKey(sha))).toBe(true);
    expect((await harness.deviceState.get('b2'))?.filePresent).toBe(true);
    expect((await transfers.get(`download:${sha}`))?.state).toBe('complete');
  });

  it('rejects a corrupt download without writing it', async () => {
    const { sha } = await makeBlob('expected-bytes');
    await seedBook(sha, 'b3', 10);
    // The server returns different bytes under the expected hash.
    server.objects.set(sha, new Blob([new TextEncoder().encode('tampered')]));
    await transfers.enqueueDownload(sha);

    const result = await engineWith(server).run();

    expect(result.failed).toBe(1);
    expect(await harness.files.has(bookFileKey(sha))).toBe(false);
    expect((await harness.deviceState.get('b3'))?.filePresent).toBeUndefined();
    expect((await transfers.get(`download:${sha}`))?.state).toBe('failed');
  });

  it('is a no-op second run once jobs have completed', async () => {
    const { blob, sha } = await makeBlob('idempotent');
    await seedBook(sha, 'b4', blob.size);
    await harness.files.put(bookFileKey(sha), blob);
    await transfers.enqueueUpload(sha);

    await engineWith(server).run();
    const second = await engineWith(server).run();

    expect(second.uploaded).toBe(0);
    expect(second.downloaded).toBe(0);
    expect(second.failed).toBe(0);
  });

  it('processes several queued jobs under bounded concurrency', async () => {
    for (let index = 0; index < 5; index += 1) {
      const { blob, sha } = await makeBlob(`concurrent-${index}`);
      await seedBook(sha, `c${index}`, blob.size);
      await harness.files.put(bookFileKey(sha), blob);
      await transfers.enqueueUpload(sha);
    }

    const result = await engineWith(server).run();

    expect(result.uploaded).toBe(5);
    expect(server.objects.size).toBe(5);
    expect((await transfers.listPending()).length).toBe(0);
  });
});

describe('transfer recovery and failure policy', () => {
  it('honors Retry-After and records a useful durable error', async () => {
    const { FileTransferHttpError } = await import('~/transfer/http-transport');
    const { sha, blob } = await makeBlob('retry');
    await harness.files.put(bookFileKey(sha), blob);
    const row = await transfers.enqueueUpload(sha);
    let calls = 0;
    const transport: FileTransport = {
      beginUpload: async () => {
        calls++;
        throw new FileTransferHttpError('Too many uploads', {
          retryable: true,
          retryAfterMs: 60000,
        });
      },
      upload: async () => {},
      finishUpload: async () => {},
      beginDownload: async () => ({ url: '' }),
      download: async () => blob,
    };
    const engine = engineWith(transport);
    await engine.run();
    const failed = await transfers.get(row.id);
    expect(failed?.retryAfter).toBeGreaterThanOrEqual(Date.now() + 59000);
    expect(failed?.error).toBe('Too many uploads');
    expect(failed?.attempts).toBe(1);
    await engine.run();
    expect(calls).toBe(1);
  });
  it('pauses permanent failures until explicit retry', async () => {
    const { FileTransferHttpError } = await import('~/transfer/http-transport');
    const { sha, blob } = await makeBlob('permanent');
    await harness.files.put(bookFileKey(sha), blob);
    const row = await transfers.enqueueUpload(sha);
    let calls = 0;
    const transport: FileTransport = {
      beginUpload: async () => {
        calls++;
        throw new FileTransferHttpError('Sign in', { retryable: false, authExpired: true });
      },
      upload: async () => {},
      finishUpload: async () => {},
      beginDownload: async () => ({ url: '' }),
      download: async () => blob,
    };
    await engineWith(transport).run();
    await engineWith(transport).run();
    expect(calls).toBe(1);
    expect((await transfers.get(row.id))?.authExpired).toBe(true);
    await transfers.retryFailed();
    await engineWith(transport).run();
    expect(calls).toBe(2);
  });
  it('cancels a live request and never marks its job complete', async () => {
    const { sha, blob } = await makeBlob('cancel');
    const row = await transfers.enqueueDownload(sha);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transport: FileTransport = {
      beginUpload: async () => ({ alreadyAvailable: false }),
      upload: async () => {},
      finishUpload: async () => {},
      beginDownload: async () => ({ url: '' }),
      download: async (_ticket, signal) => {
        started();
        return new Promise<Blob>((_resolve, reject) =>
          signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          ),
        );
      },
    };
    const engine = engineWith(transport);
    const running = engine.run();
    await startedPromise;
    await engine.cancel(row.id);
    const result = await running;
    expect(result.cancelled).toBe(1);
    expect((await transfers.get(row.id))?.state).toBe('cancelled');
    expect(await harness.files.has(bookFileKey(sha))).toBe(false);
    expect(blob.size).toBeGreaterThan(0);
  });
  it('recovers a crashed running download and verifies an existing corrupt local file again', async () => {
    const { sha, blob } = await makeBlob('repair');
    await seedBook(sha, 'repair-book', blob.size);
    await harness.files.put(bookFileKey(sha), new Blob(['corrupt']));
    server.objects.set(sha, blob);
    const row = await transfers.enqueueDownload(sha);
    await transfers.setState(row.id, 'running');
    await engineWith(server).run();
    expect(await sha256Blob(await harness.files.get(bookFileKey(sha)))).toBe(sha);
    expect((await transfers.get(row.id))?.state).toBe('complete');
  });
});
