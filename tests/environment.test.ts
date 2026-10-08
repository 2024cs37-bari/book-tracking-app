import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('exposes an IndexedDB implementation', () => {
    expect(typeof indexedDB).toBe('object');
    expect(indexedDB).not.toBeNull();
  });

  it('exposes Web Crypto with UUID and digest support', async () => {
    expect(typeof crypto.randomUUID()).toBe('string');
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
    expect(digest.byteLength).toBe(32);
  });

  it('exposes Blob and structuredClone required by storage adapters', () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    expect(blob.size).toBe(3);
    expect(structuredClone({ a: 1 })).toEqual({ a: 1 });
  });
});
