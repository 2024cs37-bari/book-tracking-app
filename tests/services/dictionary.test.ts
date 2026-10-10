import { describe, expect, it } from 'vitest';
import {
  createDictionaryService,
  normalizeLookupTerm,
  parseDictionaryResponse,
} from '~/services/dictionary';

interface Call {
  readonly url: string;
  readonly init?: RequestInit;
}

/** A stub fetch that records calls and replies via `responder`. */
function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return Promise.resolve(responder(String(url), init));
  };
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

function entryJson(word: string): Response {
  return new Response(
    JSON.stringify([
      {
        word,
        phonetic: '/həˈloʊ/',
        phonetics: [{ text: '/ignored/' }],
        meanings: [
          {
            partOfSpeech: 'noun',
            definitions: [
              { definition: 'A greeting.', example: 'She gave a warm hello.' },
              { definition: 'An expression of surprise.' },
            ],
          },
        ],
      },
    ]),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('normalizeLookupTerm', () => {
  it('takes the first token, strips surrounding punctuation and lowercases', () => {
    expect(normalizeLookupTerm('  Hello, world ')).toBe('hello');
    expect(normalizeLookupTerm('“Running”!')).toBe('running');
    expect(normalizeLookupTerm('well-being.')).toBe('well-being');
    expect(normalizeLookupTerm("don't")).toBe("don't");
  });

  it('returns null when nothing usable remains', () => {
    expect(normalizeLookupTerm('   ')).toBeNull();
    expect(normalizeLookupTerm('123!?')).toBeNull();
    expect(normalizeLookupTerm('')).toBeNull();
  });
});

describe('parseDictionaryResponse', () => {
  it('folds entries and prefers the top-level phonetic', () => {
    const entry = parseDictionaryResponse(
      [
        {
          phonetic: '/a/',
          meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'x' }] }],
        },
        { meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'y' }] }] },
      ],
      'word',
    );
    expect(entry).toEqual({
      word: 'word',
      phonetic: '/a/',
      meanings: [
        { partOfSpeech: 'noun', definitions: [{ definition: 'x' }] },
        { partOfSpeech: 'verb', definitions: [{ definition: 'y' }] },
      ],
    });
  });

  it('returns null when there are no usable meanings', () => {
    expect(parseDictionaryResponse([{ meanings: [] }], 'word')).toBeNull();
    expect(parseDictionaryResponse({ title: 'No Definitions Found' }, 'word')).toBeNull();
  });
});

describe('createDictionaryService.lookupWord', () => {
  it('hits the API for a sanitised word and parses the entry', async () => {
    const fetchImpl = stubFetch(() => entryJson('hello'));
    const service = createDictionaryService({ fetch: fetchImpl });

    const entry = await service.lookupWord('Hello!');

    expect(fetchImpl.calls[0]!.url).toBe('https://api.dictionaryapi.dev/api/v2/entries/en/hello');
    expect(entry).not.toBeNull();
    expect(entry!.word).toBe('hello');
    expect(entry!.phonetic).toBe('/həˈloʊ/');
    expect(entry!.meanings[0]!.definitions[1]).toEqual({
      definition: 'An expression of surprise.',
    });
  });

  it('caches a hit so a second lookup of the same word makes no request', async () => {
    const fetchImpl = stubFetch(() => entryJson('hello'));
    const service = createDictionaryService({ fetch: fetchImpl });

    const first = await service.lookupWord('hello');
    const second = await service.lookupWord('  HELLO ');

    expect(fetchImpl.calls).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('coalesces concurrent lookups of the same word into one request', async () => {
    const fetchImpl = stubFetch(() => entryJson('hello'));
    const service = createDictionaryService({ fetch: fetchImpl });

    const [a, b] = await Promise.all([service.lookupWord('hello'), service.lookupWord('hello')]);

    expect(fetchImpl.calls).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('returns null on a 404 and caches the miss', async () => {
    const fetchImpl = stubFetch(
      () => new Response('{"title":"No Definitions Found"}', { status: 404 }),
    );
    const service = createDictionaryService({ fetch: fetchImpl });

    expect(await service.lookupWord('qwzzx')).toBeNull();
    expect(await service.lookupWord('qwzzx')).toBeNull();
    expect(fetchImpl.calls).toHaveLength(1); // negative result cached
  });

  it('returns null without caching when the request aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }) as unknown as Response,
    );
    const service = createDictionaryService({ fetch: fetchImpl });

    const pending = service.lookupWord('hello', controller.signal);
    controller.abort();
    expect(await pending).toBeNull();

    // A later lookup still reaches the network — the abort was not cached.
    const okFetch = stubFetch(() => entryJson('hello'));
    const service2 = createDictionaryService({ fetch: okFetch });
    expect(await service2.lookupWord('hello')).not.toBeNull();
    expect(okFetch.calls).toHaveLength(1);
  });

  it('never throws and returns null when fetch rejects (offline)', async () => {
    const fetchImpl = stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const service = createDictionaryService({ fetch: fetchImpl });

    await expect(service.lookupWord('hello')).resolves.toBeNull();
  });

  it('returns null for input that sanitises to nothing, without any request', async () => {
    const fetchImpl = stubFetch(() => entryJson('hello'));
    const service = createDictionaryService({ fetch: fetchImpl });

    expect(await service.lookupWord('  !!! ')).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('respects a timeout by returning null', async () => {
    const fetchImpl = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }) as unknown as Response,
    );
    const service = createDictionaryService({ fetch: fetchImpl, timeoutMs: 5 });

    await expect(service.lookupWord('hello')).resolves.toBeNull();
  });
});
