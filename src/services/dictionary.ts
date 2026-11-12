import { dictionaryAllowed } from './privacy-preferences';

/**
 * In-text dictionary lookup backed by the free dictionaryapi.dev service.
 *
 * The service is deliberately defensive because it is driven straight from a
 * reader selection and runs in an offline-first app: it never throws, returns
 * `null` for anything it cannot resolve (bad input, 404, offline, timeout,
 * abort), caches both hits and definitive misses in memory, coalesces
 * concurrent lookups of the same word into one request, and bounds every call
 * with a timeout that composes with a caller-supplied `AbortSignal`.
 */

/** A single sense within a part of speech. */
export interface DictionaryDefinition {
  readonly definition: string;
  readonly example?: string;
}

/** All senses sharing one part of speech (e.g. all noun meanings). */
export interface DictionaryMeaning {
  readonly partOfSpeech: string;
  readonly definitions: readonly DictionaryDefinition[];
}

/** A resolved dictionary entry for a single word. */
export interface DictionaryEntry {
  readonly word: string;
  readonly phonetic?: string;
  readonly meanings: readonly DictionaryMeaning[];
}

export interface DictionaryServiceOptions {
  /** Injectable fetch for tests; defaults to the global. */
  readonly fetch?: typeof fetch;
  /** API root; the word is appended. Defaults to the public dictionaryapi.dev. */
  readonly endpoint?: string;
  /** Per-request timeout in milliseconds before the lookup is abandoned. */
  readonly timeoutMs?: number;
  /** Successful and missing entries share one bounded LRU cache. */
  readonly cacheEntries?: number;
  readonly cacheTtlMs?: number;
}

export interface DictionaryService {
  /**
   * Resolve `word` to an entry, or `null` when it cannot be resolved for any
   * reason. Pass `signal` to cancel from the caller (e.g. the popup closed);
   * cancellation also yields `null` rather than throwing.
   */
  lookupWord(word: string, signal?: AbortSignal): Promise<DictionaryEntry | null>;
}

const DEFAULT_ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const DEFAULT_TIMEOUT_MS = 6000;
export const MAX_DICTIONARY_RESPONSE_BYTES = 256 * 1024;
const MAX_LOOKUP_CHARACTERS = 128;
const MAX_PARSED_TEXT = 4096;

/**
 * Reduce arbitrary selected text to a single lookup key: the first whitespace-
 * delimited token, stripped of surrounding punctuation, lowercased. Internal
 * apostrophes and hyphens are kept (e.g. "don't", "well-being"). Returns `null`
 * when nothing usable remains, so the caller can skip the network entirely.
 */
export function normalizeLookupTerm(raw: string): string | null {
  if (raw.length > 4096) return null;
  const [first] = raw.trim().split(/\s+/u);
  if (first === undefined) return null;
  const cleaned = first
    .replace(/[^\p{L}\p{M}'-]/gu, '')
    .replace(/^[-']+|[-']+$/gu, '')
    .toLowerCase();
  return cleaned.length > 0 && cleaned.length <= MAX_LOOKUP_CHARACTERS ? cleaned : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.slice(0, MAX_PARSED_TEXT)
    : undefined;
}

function parseDefinitions(value: unknown): DictionaryDefinition[] {
  if (!Array.isArray(value)) return [];
  const result: DictionaryDefinition[] = [];
  for (const raw of value.slice(0, 32)) {
    if (raw === null || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const definition = asString(record.definition);
    if (definition === undefined) continue;
    const example = asString(record.example);
    result.push(example === undefined ? { definition } : { definition, example });
  }
  return result;
}

function parseMeanings(value: unknown): DictionaryMeaning[] {
  if (!Array.isArray(value)) return [];
  const result: DictionaryMeaning[] = [];
  for (const raw of value.slice(0, 32)) {
    if (raw === null || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const definitions = parseDefinitions(record.definitions);
    if (definitions.length === 0) continue;
    result.push({ partOfSpeech: asString(record.partOfSpeech) ?? 'other', definitions });
  }
  return result;
}

/** Pull a phonetic string from the top-level field or the `phonetics` array. */
function parsePhonetic(record: Record<string, unknown>): string | undefined {
  const direct = asString(record.phonetic);
  if (direct !== undefined) return direct;
  const phonetics = record.phonetics;
  if (!Array.isArray(phonetics)) return undefined;
  for (const raw of phonetics.slice(0, 16)) {
    if (raw === null || typeof raw !== 'object') continue;
    const text = asString((raw as Record<string, unknown>).text);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Validate and fold the dictionaryapi.dev payload (an array of entries) into a
 * single entry: meanings from every entry are merged so alternate records do
 * not drop senses. Returns `null` when the shape yields nothing usable.
 */
export function parseDictionaryResponse(payload: unknown, word: string): DictionaryEntry | null {
  if (!Array.isArray(payload)) return null;
  const meanings: DictionaryMeaning[] = [];
  let phonetic: string | undefined;
  for (const raw of payload.slice(0, 16)) {
    if (raw === null || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    phonetic ??= parsePhonetic(record);
    meanings.push(...parseMeanings(record.meanings));
  }
  if (meanings.length === 0) return null;
  const entry: DictionaryEntry = { word, meanings };
  return phonetic === undefined ? entry : { ...entry, phonetic };
}

interface PendingLookup {
  readonly controller: AbortController;
  readonly promise: Promise<DictionaryEntry | null>;
  consumers: number;
}

/** Each caller can leave a shared request without cancelling another caller. */
function subscribe(pending: PendingLookup, signal?: AbortSignal): Promise<DictionaryEntry | null> {
  pending.consumers += 1;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: DictionaryEntry | null): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      pending.consumers -= 1;
      if (pending.consumers === 0) pending.controller.abort();
      resolve(value);
    };
    const abort = (): void => settle(null);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    void pending.promise.then(settle, () => settle(null));
  });
}

/** A total deadline covers response headers and body consumption alike. */
export function createDictionaryService(options: DictionaryServiceOptions = {}): DictionaryService {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(options.timeoutMs!, 60_000))
    : DEFAULT_TIMEOUT_MS;
  const cacheEntries = Number.isSafeInteger(options.cacheEntries)
    ? Math.max(0, Math.min(options.cacheEntries!, 1024))
    : 256;
  const ttl = Number.isFinite(options.cacheTtlMs) ? Math.max(0, options.cacheTtlMs!) : 3_600_000;
  const cache = new Map<string, { value: DictionaryEntry | null; expires: number }>();
  const inFlight = new Map<string, PendingLookup>();

  const remember = (term: string, value: DictionaryEntry | null): void => {
    if (cacheEntries === 0) return;
    cache.delete(term);
    cache.set(term, { value, expires: Date.now() + ttl });
    while (cache.size > cacheEntries) cache.delete(cache.keys().next().value!);
  };

  async function resolve(
    term: string,
    controller: AbortController,
  ): Promise<DictionaryEntry | null> {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Reader cancellation also bounds test/custom streams that don't inherit fetch's signal.
    const stopReading = (): void => {
      void reader?.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener('abort', stopReading, { once: true });
    try {
      const response = await doFetch(`${endpoint}${encodeURIComponent(term)}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
      if (controller.signal.aborted) {
        await response.body?.cancel();
        return null;
      }
      if (response.status === 404) {
        await response.body?.cancel();
        remember(term, null);
        return null;
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        return null;
      }
      if (Number(response.headers.get('content-length')) > MAX_DICTIONARY_RESPONSE_BYTES) {
        await response.body.cancel();
        return null;
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '';
      let bytes = 0;
      while (true) {
        const next = await reader.read();
        if (controller.signal.aborted) return null;
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_DICTIONARY_RESPONSE_BYTES) {
          await reader.cancel();
          return null;
        }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      const entry = parseDictionaryResponse(JSON.parse(text), term);
      if (entry !== null && !controller.signal.aborted) remember(term, entry);
      return controller.signal.aborted ? null : entry;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', stopReading);
      reader?.releaseLock();
    }
  }

  return {
    async lookupWord(word: string, signal?: AbortSignal): Promise<DictionaryEntry | null> {
      try {
        const term = normalizeLookupTerm(word);
        if (term === null || signal?.aborted) return null;
        const hit = cache.get(term);
        if (hit && hit.expires > Date.now()) {
          cache.delete(term);
          cache.set(term, hit);
          return hit.value;
        }
        cache.delete(term);
        let pending = inFlight.get(term);
        if (pending?.controller.signal.aborted) pending = undefined;
        if (!pending) {
          // Bound distinct concurrent requests as well as cached results.
          if (inFlight.size >= 16) return null;
          const controller = new AbortController();
          const promise = resolve(term, controller).finally(() => {
            if (inFlight.get(term)?.controller === controller) inFlight.delete(term);
          });
          pending = { controller, promise, consumers: 0 };
          inFlight.set(term, pending);
        }
        return await subscribe(pending, signal);
      } catch {
        return null;
      }
    },
  };
}

/** Shared default instance bound to the global fetch, for app wiring. */
const defaultService = createDictionaryService();

/**
 * Resolve `word` to a dictionary entry, or `null` when it cannot be resolved.
 * Convenience binding over the shared default service; never throws.
 */
export function lookupWord(word: string, signal?: AbortSignal): Promise<DictionaryEntry | null> {
  if (!dictionaryAllowed()) return Promise.resolve(null);
  return defaultService.lookupWord(word, signal);
}
