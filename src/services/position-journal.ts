import { assertLocator, type Locator } from '~/domain/locator';
import { isSha256Hex, newId } from '~/domain/ids';

export const POSITION_JOURNAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_JOURNAL_SCAN_KEYS = 10_000;

export interface PositionIntent {
  readonly token: string;
  readonly locator: Locator;
  readonly recordedAt: number;
  readonly sha256?: string;
}

/** Tiny synchronous crash-recovery journal independent of the IndexedDB outbox. */
export class PositionJournal {
  private readonly memory = new Map<string, PositionIntent>();
  private readonly cleared = new Set<string>();
  private readonly unpersisted = new Set<string>();
  constructor(
    private readonly namespace = 'book-reader',
    private readonly storage = (): Storage | undefined =>
      typeof window === 'undefined' ? undefined : window.localStorage,
  ) {}
  private key(bookId: string): string {
    return `book-reader:unsaved-position:v1:${encodeURIComponent(this.namespace)}:${bookId}`;
  }

  read(bookId: string): PositionIntent | undefined {
    let memory = this.memory.get(bookId);
    if (memory && Date.now() - memory.recordedAt > POSITION_JOURNAL_MAX_AGE_MS) {
      this.clear(bookId, memory.token);
      memory = undefined;
    }
    try {
      const raw = this.storage()?.getItem(this.key(bookId));
      if (raw && raw.length <= 4096) {
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'token' in parsed &&
          typeof parsed.token === 'string' &&
          parsed.token.length <= 128 &&
          !this.cleared.has(parsed.token) &&
          'recordedAt' in parsed &&
          typeof parsed.recordedAt === 'number' &&
          Number.isSafeInteger(parsed.recordedAt) &&
          parsed.recordedAt >= Date.now() - POSITION_JOURNAL_MAX_AGE_MS &&
          parsed.recordedAt <= Date.now() + 86_400_000 &&
          (!('sha256' in parsed) || parsed.sha256 === undefined || isSha256Hex(parsed.sha256)) &&
          'locator' in parsed
        ) {
          const persisted: PositionIntent = {
            token: parsed.token,
            locator: assertLocator(parsed.locator),
            recordedAt: parsed.recordedAt,
            sha256: 'sha256' in parsed ? (parsed.sha256 as string | undefined) : undefined,
          };
          // Another tab may have journaled a newer intent after our memory copy.
          // At equal milliseconds storage is the last successful writer, unless
          // this instance's newer intent could not be persisted at all.
          if (
            !memory ||
            persisted.recordedAt > memory.recordedAt ||
            (persisted.recordedAt === memory.recordedAt && !this.unpersisted.has(memory.token))
          )
            return persisted;
        }
      }
    } catch {
      /* Storage may be disabled; the same app session can still retry. */
    }
    return memory;
  }

  write(bookId: string, locator: Locator, sha256?: string): PositionIntent {
    const intent = {
      token: newId(),
      locator: { ...assertLocator(locator) },
      recordedAt: Date.now(),
      sha256,
    };
    this.store(bookId, intent);
    return intent;
  }
  private store(bookId: string, intent: PositionIntent): void {
    const previous = this.memory.get(bookId);
    if (previous) this.unpersisted.delete(previous.token);
    this.memory.set(bookId, intent);
    this.unpersisted.add(intent.token);
    try {
      const storage = this.storage();
      if (storage) {
        storage.setItem(this.key(bookId), JSON.stringify(intent));
        this.unpersisted.delete(intent.token);
      }
    } catch {
      /* Retain memory copy and show save failure if IndexedDB also fails. */
    }
  }

  migrate(fromBookId: string, toBookId: string): void {
    if (fromBookId === toBookId) return;
    const source = this.read(fromBookId);
    if (!source) return;
    let target = this.read(toBookId);
    if (!target || source.recordedAt > target.recordedAt) {
      target = { ...source, token: newId() };
      this.store(toBookId, target);
    }
    // A quota/storage failure must not delete the only durable source intent.
    // Keeping a duplicate is recoverable; losing it during migration is not.
    if (!this.unpersisted.has(target.token)) this.clear(fromBookId, source.token);
  }

  /** Recover legacy UUID journals after sync has retired their reader route. */
  migrateOriginal(sha256: string, toBookId: string): void {
    const ids = new Set(this.memory.keys());
    try {
      const storage = this.storage();
      const prefix = this.key('');
      for (
        let index = 0;
        storage && index < Math.min(storage.length, MAX_JOURNAL_SCAN_KEYS);
        index++
      ) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) ids.add(key.slice(prefix.length));
      }
    } catch {
      /* In-memory journals still migrate if storage enumeration is disabled. */
    }
    for (const id of ids) {
      if (id !== toBookId && this.read(id)?.sha256 === sha256) this.migrate(id, toBookId);
    }
  }

  clear(bookId: string, token: string): void {
    if (this.memory.get(bookId)?.token === token) this.memory.delete(bookId);
    this.unpersisted.delete(token);
    this.cleared.add(token);
    if (this.cleared.size > 256) this.cleared.delete(this.cleared.values().next().value!);
    try {
      const storage = this.storage();
      const raw = storage?.getItem(this.key(bookId));
      if (raw) {
        const current = JSON.parse(raw) as { token?: unknown };
        if (current.token === token) storage?.removeItem(this.key(bookId));
      }
    } catch {
      /* An old journal entry is safer than losing an unsaved position. */
    }
  }
}
