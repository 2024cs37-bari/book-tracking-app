import { describe, expect, it } from 'vitest';
import { compareHlc, createClock, formatHlc, parseHlc, type Hlc } from '~/domain/hlc';

function clockAt(times: number[], deviceId: string) {
  let index = 0;
  return createClock({
    deviceId,
    now: () => times[Math.min(index++, times.length - 1)] ?? 0,
  });
}

describe('HLC serialization', () => {
  it('round-trips through its string form', () => {
    const hlc: Hlc = { wallMs: 1_700_000_000_000, counter: 7, deviceId: 'device-a' };
    expect(parseHlc(formatHlc(hlc))).toEqual(hlc);
  });

  it('rejects malformed values', () => {
    for (const value of ['', '1', '1:', ':1:a', '1:2:', 'a:2:c', '1:b:c', '1:2', '-1:2:c']) {
      expect(parseHlc(value), `expected "${value}" to be rejected`).toBeNull();
    }
  });
});

describe('HLC ordering', () => {
  it('orders by wall clock first', () => {
    const earlier: Hlc = { wallMs: 10, counter: 5, deviceId: 'z' };
    const later: Hlc = { wallMs: 11, counter: 0, deviceId: 'a' };
    expect(compareHlc(earlier, later)).toBe(-1);
  });

  it('breaks wall-clock ties with the counter', () => {
    const lower: Hlc = { wallMs: 10, counter: 1, deviceId: 'z' };
    const higher: Hlc = { wallMs: 10, counter: 2, deviceId: 'a' };
    expect(compareHlc(lower, higher)).toBe(-1);
  });

  it('breaks remaining ties deterministically by device id', () => {
    const first: Hlc = { wallMs: 10, counter: 1, deviceId: 'a' };
    const second: Hlc = { wallMs: 10, counter: 1, deviceId: 'b' };
    expect(compareHlc(first, second)).toBe(-1);
    expect(compareHlc(second, first)).toBe(1);
    expect(compareHlc(first, first)).toBe(0);
  });
});

describe('HLC clock', () => {
  it('produces strictly increasing values on a frozen clock', () => {
    const clock = clockAt([1000], 'device-a');
    const first = clock.next();
    const second = clock.next();
    const third = clock.next();

    expect(second.wallMs).toBe(first.wallMs);
    expect(second.counter).toBe(first.counter + 1);
    expect(compareHlc(first, second)).toBe(-1);
    expect(compareHlc(second, third)).toBe(-1);
  });

  it('resets the counter when wall time advances', () => {
    const clock = clockAt([1000, 1000, 2000], 'device-a');
    clock.next();
    clock.next();
    const advanced = clock.next();
    expect(advanced.wallMs).toBe(2000);
    expect(advanced.counter).toBe(0);
  });

  it('never goes backwards when the wall clock does', () => {
    const clock = clockAt([5000, 4000, 3000], 'device-a');
    const first = clock.next();
    const second = clock.next();
    const third = clock.next();
    expect(compareHlc(first, second)).toBe(-1);
    expect(compareHlc(second, third)).toBe(-1);
    expect(third.wallMs).toBe(5000);
  });

  it('sorts after an observed remote event, even with a slower clock', () => {
    const local = clockAt([1000, 1000, 1000], 'device-a');
    local.next();
    const remote: Hlc = { wallMs: 2000, counter: 4, deviceId: 'device-b' };
    local.observe(remote);
    const next = local.next();
    expect(compareHlc(remote, next)).toBe(-1);
  });

  it('converges to the same ordering on both devices after exchanging events', () => {
    const deviceA = clockAt([1000, 1000, 1000], 'device-a');
    const deviceB = clockAt([1400, 1400, 1400], 'device-b');

    const a1 = deviceA.next();
    const b1 = deviceB.next();
    deviceA.observe(b1);
    deviceB.observe(a1);
    const a2 = deviceA.next();
    const b2 = deviceB.next();

    const orderingFromA = [a1, b1, a2, b2].map(formatHlc).sort();
    const orderingFromB = [a1, b1, b2, a2].map(formatHlc).sort();
    expect(orderingFromA).toEqual(orderingFromB);
    expect(compareHlc(a1, a2)).toBe(-1);
    expect(compareHlc(b1, b2)).toBe(-1);
  });

  it('clamps a remote timestamp from far in the future and reports it', () => {
    const clamps: number[] = [];
    const clock = createClock({
      deviceId: 'device-a',
      now: () => 1000,
      maxDriftMs: 500,
      onDriftClamp: (event) => clamps.push(event.remoteWallMs),
    });

    clock.observe({ wallMs: 10_000_000, counter: 0, deviceId: 'broken-clock' });
    const next = clock.next();

    expect(clamps).toEqual([10_000_000]);
    expect(next.wallMs).toBeLessThanOrEqual(1500);
  });

  it('restores persisted state only when it is ahead of the current value', () => {
    const clock = clockAt([1000], 'device-a');
    clock.next();
    clock.restore({ wallMs: 5000, counter: 2, deviceId: 'device-a' });
    expect(clock.last()?.wallMs).toBe(5000);

    clock.restore({ wallMs: 100, counter: 0, deviceId: 'device-a' });
    expect(clock.last()?.wallMs).toBe(5000);
  });
});
