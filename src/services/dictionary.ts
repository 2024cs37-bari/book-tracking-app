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

/**
 * Reduce arbitrary selected text to a single lookup key: the first whitespace-
 * delimited token, stripped of surrounding punctuation, lowercased. Internal
 * apostrophes and hyphens are kept (e.g. "don't", "well-being"). Returns `null`
 * when nothing usable remains, so the caller can skip the network entirely.
 */
export function normalizeLookupTerm(raw: string): string | null {
  const [first] = raw.trim().split(/\s+/u);
  if (first === undefined) return null;
  const cleaned = first
    .replace(/[^\p{L}\p{M}'-]/gu, '')
    .replace(/^[-']+|[-']+$/gu, '')
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function parseDefinitions(value: unknown): DictionaryDefinition[] {
  if (!Array.isArray(value)) return [];
  const result: DictionaryDefinition[] = [];
  for (const raw of value) {
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
  for (const raw of value) {
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
  for (const raw of phonetics) {
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
  for (const raw of payload) {
    if (raw === null || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    phonetic ??= parsePhonetic(record);
    meanings.push(...parseMeanings(record.meanings));
  }
  if (meanings.length === 0) return null;
  const entry: DictionaryEntry = { word, meanings };
  return phonetic === undefined ? entry : { ...entry, phonetic };
}

/**
 * Run `fetch` with a timeout that also honours the caller's signal. Resolves to
 * the Response, or `null` if the request was aborted, timed out or failed at
 * the transport level (offline). HTTP error statuses still resolve to a
 * Response so the caller can distinguish a 404 from a network failure.
 */
async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response | null> {
  if (signal?.aborted === true) return null;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    // Abort, timeout and offline all surface here; none are cached (transient).
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Build a dictionary service bound to the given fetch. Lookups are memoised:
 * successful entries and definitive 404 misses are cached for the lifetime of
 * the service, and concurrent lookups of the same term share one in-flight
 * request. Transient failures (offline, timeout, abort) are never cached.
 */
export function createDictionaryService(options: DictionaryServiceOptions = {}): DictionaryService {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = new Map<string, DictionaryEntry | null>();
  const inFlight = new Map<string, Promise<DictionaryEntry | null>>();

  async function resolve(
    term: string,
    signal: AbortSignal | undefined,
  ): Promise<DictionaryEntry | null> {
    const response = await fetchWithTimeout(
      doFetch,
      `${endpoint}${encodeURIComponent(term)}`,
      timeoutMs,
      signal,
    );
    if (response === null) return null; // Transient: do not cache, allow a retry.
    if (response.status === 404) {
      cache.set(term, null); // Definitive miss: cache so we never ask again.
      return null;
    }
    if (!response.ok) return null; // 429/5xx etc.: transient, not cached.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    const entry = parseDictionaryResponse(payload, term);
    if (entry !== null) cache.set(term, entry);
    return entry;
  }

  return {
    async lookupWord(word: string, signal?: AbortSignal): Promise<DictionaryEntry | null> {
      try {
        const term = normalizeLookupTerm(word);
        if (term === null) return null;
        const cached = cache.get(term);
        if (cached !== undefined || cache.has(term)) return cached ?? null;
        const existing = inFlight.get(term);
        if (existing !== undefined) return await existing;
        const pending = resolve(term, signal);
        inFlight.set(term, pending);
        try {
          return await pending;
        } finally {
          inFlight.delete(term);
        }
      } catch {
        // Contract: lookups never throw, whatever goes wrong.
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
  return defaultService.lookupWord(word, signal);
}
