/**
 * Hybrid Logical Clock.
 *
 * Wall-clock time alone cannot order mutations across devices with drifting
 * clocks, and a logical counter alone cannot stay close to real time. An HLC
 * keeps both: the wall component stays near physical time, the counter keeps
 * ordering monotonic, and the device id breaks ties deterministically.
 *
 * The serialized form is `<wallMs>:<counter>:<deviceId>`.
 */

export interface Hlc {
  readonly wallMs: number;
  readonly counter: number;
  readonly deviceId: string;
}

/**
 * Upper bound on the logical counter. A value above this indicates a corrupted
 * or hostile peer rather than legitimate clock behaviour.
 */
export const MAX_HLC_COUNTER = 0x7fffffff;

const DEFAULT_MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export function formatHlc(hlc: Hlc): string {
  return `${hlc.wallMs}:${hlc.counter}:${hlc.deviceId}`;
}

export function parseHlc(value: string): Hlc | null {
  const firstSeparator = value.indexOf(':');
  if (firstSeparator <= 0) return null;
  const secondSeparator = value.indexOf(':', firstSeparator + 1);
  if (secondSeparator <= firstSeparator + 1) return null;

  const wallText = value.slice(0, firstSeparator);
  const counterText = value.slice(firstSeparator + 1, secondSeparator);
  const deviceId = value.slice(secondSeparator + 1);
  if (!/^\d+$/.test(wallText) || !/^\d+$/.test(counterText)) return null;
  if (deviceId.length === 0) return null;

  const wallMs = Number(wallText);
  const counter = Number(counterText);
  if (!Number.isSafeInteger(wallMs) || !Number.isSafeInteger(counter)) return null;
  if (counter > MAX_HLC_COUNTER) return null;

  return { wallMs, counter, deviceId };
}

/** Total order over HLC values: wall, then counter, then device id. */
export function compareHlc(left: Hlc, right: Hlc): number {
  if (left.wallMs !== right.wallMs) return left.wallMs < right.wallMs ? -1 : 1;
  if (left.counter !== right.counter) return left.counter < right.counter ? -1 : 1;
  if (left.deviceId === right.deviceId) return 0;
  return left.deviceId < right.deviceId ? -1 : 1;
}

export interface DriftClampEvent {
  readonly remoteWallMs: number;
  readonly clampedWallMs: number;
  readonly deviceId: string;
}

export interface ClockOptions {
  readonly deviceId: string;
  /** Injectable time source; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Remote timestamps further ahead than this are clamped. */
  readonly maxDriftMs?: number;
  /** Diagnostics hook, called when a remote timestamp is clamped. */
  readonly onDriftClamp?: (event: DriftClampEvent) => void;
}

export interface Clock {
  readonly deviceId: string;
  /** Produces a new monotonically increasing HLC for a local mutation. */
  next(): Hlc;
  /** Merges a remote HLC so later local mutations sort after it. */
  observe(remote: Hlc): void;
  /** Last issued value, or null before the first call to `next`. */
  last(): Hlc | null;
  /** Restores persisted clock state from a previous session. */
  restore(hlc: Hlc): void;
}

export function createClock(options: ClockOptions): Clock {
  const {
    deviceId,
    now = () => Date.now(),
    maxDriftMs = DEFAULT_MAX_DRIFT_MS,
    onDriftClamp,
  } = options;

  let last: Hlc | null = null;

  function next(): Hlc {
    const physical = now();
    if (last === null) {
      last = { wallMs: physical, counter: 0, deviceId };
      return last;
    }
    const wallMs = Math.max(physical, last.wallMs);
    const counter = wallMs === last.wallMs ? last.counter + 1 : 0;
    last = { wallMs, counter, deviceId };
    return last;
  }

  function observe(remote: Hlc): void {
    const physical = now();
    const remoteCeiling = physical + maxDriftMs;
    let remoteWallMs = remote.wallMs;
    if (remoteWallMs > remoteCeiling) {
      remoteWallMs = remoteCeiling;
      onDriftClamp?.({
        remoteWallMs: remote.wallMs,
        clampedWallMs: remoteCeiling,
        deviceId: remote.deviceId,
      });
    }

    if (last === null) {
      last = { wallMs: Math.max(physical, remoteWallMs), counter: 0, deviceId };
      return;
    }

    const wallMs = Math.max(physical, last.wallMs, remoteWallMs);
    let counter: number;
    if (wallMs === last.wallMs && wallMs === remoteWallMs) {
      counter = Math.max(last.counter, remote.counter) + 1;
    } else if (wallMs === last.wallMs) {
      counter = last.counter + 1;
    } else if (wallMs === remoteWallMs) {
      counter = remote.counter + 1;
    } else {
      counter = 0;
    }
    last = { wallMs, counter, deviceId };
  }

  function restore(hlc: Hlc): void {
    if (last === null || compareHlc(hlc, last) > 0) {
      last = { ...hlc, deviceId };
    }
  }

  return {
    deviceId,
    next,
    observe,
    restore,
    last: () => last,
  };
}
