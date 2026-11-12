import { describe, expect, it } from 'vitest';
import { applicationCsp, syncOrigin } from '../tooling/network-policy';

describe('application network policy', () => {
  it('allows only the configured sync origin and dictionary service in production', () => {
    const csp = applicationCsp({ syncUrl: 'https://sync.example.test/api/' });
    expect(csp).toContain(
      "connect-src 'self' https://sync.example.test https://api.dictionaryapi.dev;",
    );
    expect(csp).not.toMatch(/\bws:|\bwss:|https:\s|\*/);
    expect(csp).toContain("script-src 'self'; object-src 'none'");
  });

  it('grants native IPC only to the explicit desktop build', () => {
    expect(applicationCsp({ desktop: true })).toContain(' ipc: http://ipc.localhost');
    expect(applicationCsp()).not.toContain('ipc:');
  });

  it('can disable external dictionary connections entirely', () => {
    expect(applicationCsp({ dictionaryEnabled: false })).toContain("connect-src 'self';");
  });

  it('limits development websockets to explicitly observed server origins', () => {
    const csp = applicationCsp({ development: true, websocketOrigins: ['ws://localhost:5173'] });
    expect(csp).toContain(' ws://localhost:5173;');
    expect(applicationCsp({ websocketOrigins: ['ws://localhost:5173'] })).not.toContain('ws:');
    expect(syncOrigin('http://127.0.0.1:8787/api', true)).toBe('http://127.0.0.1:8787');
  });

  it.each([
    'http://sync.example.test/api',
    'http://127.0.0.1:8787/api',
    'https://name:secret@sync.example.test/api',
    'https://sync.example.test/api?token=secret',
    'https://sync.example.test/api#secret',
    'javascript:alert(1)',
    '/api',
    'https://sync.example.test;script-src unsafe-inline',
    'https://*.example.test/api',
    'https://example.test;script-src/api',
    'https://example$&.test/api',
  ])('rejects unsafe or ambiguous public configuration: %s', (url) => {
    expect(() => syncOrigin(url)).toThrow();
  });
});

it('rejects configured desktop sync until a native Access authentication flow exists', () => {
  expect(() =>
    applicationCsp({ desktop: true, syncUrl: 'https://reader.example.test/api' }),
  ).toThrow('native authentication flow');
  expect(() =>
    applicationCsp({ desktop: true, syncUrl: 'http://127.0.0.1:8787/api', development: true }),
  ).toThrow('native authentication flow');
  expect(applicationCsp({ desktop: true, syncUrl: '' })).toContain('http://ipc.localhost');
});
