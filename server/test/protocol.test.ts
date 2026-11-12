import { describe, expect, it } from 'vitest';
import {
  MAX_PAYLOAD_BYTES,
  MAX_PUSH_BATCH,
  validatePushChange,
  validatePushRequest,
} from '../src/protocol';
import { readJson } from '../src/request';

const change = () => ({
  id: 'c1',
  entity: 'book',
  entity_id: 'b1',
  op: 'upsert',
  hlc: '1:0:device',
  payload: { title: 'A' },
});

describe('untrusted push validation', () => {
  it('requires supported schema and a bounded envelope', () => {
    const request = { schema_version: 2, device_id: 'd', changes: [] };
    expect(validatePushRequest(request)).toBeNull();
    expect(validatePushRequest(null)).toBe('not_object');
    expect(validatePushRequest([])).toBe('not_object');
    expect(validatePushRequest({ ...request, device_id: 'd'.repeat(129) })).toBe('bad_device');
    expect(validatePushRequest({ ...request, schema_version: 0 })).toBe('bad_schema');
    expect(validatePushRequest({ ...request, schema_version: 3 })).toBe('schema_mismatch');
    expect(validatePushRequest({ ...request, changes: Array(MAX_PUSH_BATCH + 1).fill(null) })).toBe(
      'too_many',
    );
  });

  it('bounds payload UTF-8 bytes and safe clock values without throwing', () => {
    expect(validatePushChange(change())).toBe(true);
    for (const payload of [
      null,
      [],
      undefined,
      BigInt(1),
      { title: '文'.repeat(MAX_PAYLOAD_BYTES / 2) },
    ]) {
      expect(validatePushChange({ ...change(), payload })).toBe(false);
    }
    expect(validatePushChange({ ...change(), hlc: '9007199254740992:0:d' })).toBe(false);
    expect(validatePushChange({ ...change(), hlc: '1:9007199254740992:d' })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validatePushChange({ ...change(), payload: cyclic })).toBe(false);
  });
});

describe('bounded JSON reads', () => {
  const req = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  it('limits actual bytes with or without an accurate content-length', async () => {
    await expect(readJson(req('{"v":"文文文"}'), 12)).rejects.toMatchObject({ status: 413 });
    await expect(
      readJson(req('{"v":"too long"}', { 'content-length': '1' }), 12),
    ).rejects.toMatchObject({ status: 413 });
    await expect(readJson(req('{}', { 'content-length': '4' }), 12)).rejects.toMatchObject({
      code: 'bad_content_length',
    });
  });
  it('rejects unsupported formats and malformed JSON with consistent errors', async () => {
    await expect(readJson(req('{}', { 'content-type': 'text/plain' }), 12)).rejects.toMatchObject({
      status: 415,
    });
    await expect(readJson(req('{'), 12)).rejects.toMatchObject({ code: 'bad_json' });
    await expect(readJson(req('{}', { 'content-length': '-1' }), 12)).rejects.toMatchObject({
      code: 'bad_content_length',
    });
    await expect(readJson(req('{}'), 12)).resolves.toEqual({});
  });
});
