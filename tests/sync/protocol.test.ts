import { describe, expect, it } from 'vitest';
import { buildPushRequest, isPullResponse, isPushResponse, toPushChange } from '~/sync/protocol';
import type { ChangeRow } from '~/data/db';

function row(partial: Partial<ChangeRow> = {}): ChangeRow {
  return {
    id: 'c1',
    entity: 'progress',
    entityId: 'b1',
    op: 'upsert',
    payload: JSON.stringify({ bookId: 'b1', fraction: 0.42 }),
    hlc: '100:0:device',
    deviceId: 'device',
    createdAt: 1,
    pushedAt: 0,
    ...partial,
  };
}

describe('push request building', () => {
  it('parses the stored payload and carries the schema version', () => {
    const request = buildPushRequest('device', [row()]);
    expect(request.device_id).toBe('device');
    expect(request.schema_version).toBeGreaterThan(0);
    expect(request.changes[0]).toMatchObject({
      id: 'c1',
      entity: 'progress',
      entity_id: 'b1',
      op: 'upsert',
      hlc: '100:0:device',
    });
    expect((request.changes[0] as { payload: { fraction: number } }).payload.fraction).toBe(0.42);
  });

  it('round-trips a single row via toPushChange', () => {
    expect(toPushChange(row({ id: 'x' })).id).toBe('x');
  });
});

describe('isPushResponse', () => {
  it('accepts a well-formed response and rejects malformed ones', () => {
    expect(isPushResponse({ outcomes: [{ id: 'c1', status: 'accepted', seq: 3 }] })).toBe(true);
    expect(isPushResponse({ outcomes: [{ id: 'c1', status: 'duplicate' }] })).toBe(true);
    expect(isPushResponse({ outcomes: [{ id: 'c1', status: 'nope' }] })).toBe(false);
    expect(isPushResponse({ outcomes: [{ status: 'accepted' }] })).toBe(false);
    expect(isPushResponse({ outcomes: 'no' })).toBe(false);
    expect(isPushResponse(null)).toBe(false);
  });
});

describe('isPullResponse', () => {
  const valid = {
    changes: [
      { seq: 1, change_id: 'c1', entity: 'book', entity_id: 'b1', hlc: '1:0:d', payload: {} },
    ],
    next_cursor: 1,
    has_more: false,
    schema_version: 1,
  };

  it('accepts a well-formed envelope', () => {
    expect(isPullResponse(valid)).toBe(true);
    expect(isPullResponse({ ...valid, changes: [], next_cursor: 0 })).toBe(true);
  });

  it('rejects bad cursors, flags and unknown entities', () => {
    expect(isPullResponse({ ...valid, next_cursor: -1 })).toBe(false);
    expect(isPullResponse({ ...valid, has_more: 'no' })).toBe(false);
    expect(
      isPullResponse({
        ...valid,
        changes: [
          { seq: 1, change_id: 'c', entity: 'spaceship', entity_id: 'x', hlc: 'h', payload: {} },
        ],
      }),
    ).toBe(false);
    expect(
      isPullResponse({ ...valid, changes: [{ seq: 1, change_id: 'c', entity: 'book', hlc: 'h' }] }),
    ).toBe(false);
  });
});
