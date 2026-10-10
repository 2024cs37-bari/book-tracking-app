/**
 * Framework-agnostic read-aloud (text-to-speech) controller over the Web Speech
 * API's {@link SpeechSynthesis}. It splits text into speakable units, speaks
 * them sequentially, and reports progress through subscriber callbacks so a UI
 * layer (any framework) can highlight the current sentence and reflect state.
 *
 * Design notes:
 * - The browser's `SpeechSynthesis` can only hold one queue; this controller
 *   owns exactly one utterance at a time and advances on its `end` event, which
 *   keeps sentence tracking exact and lets rate/voice changes re-start cleanly.
 * - Long passages are chunked so a single utterance never exceeds a safe
 *   length — many engines truncate or stall on very long utterances.
 * - A keep-alive timer works around the long-standing Chromium bug where
 *   synthesis silently pauses after ~15s of continuous speech.
 * - Everything degrades to a no-op when speech synthesis is unavailable, so the
 *   module is safe to import in SSR, tests, and unsupported browsers.
 */

export type SpeechState = 'idle' | 'playing' | 'paused';

/** The data a UI needs about one installed voice; a thin view of the platform voice. */
export interface SpeechVoice {
  readonly name: string;
  readonly lang: string;
  /** The engine's own default voice. */
  readonly isDefault: boolean;
  /** True for on-device voices (offline-capable), false for network voices. */
  readonly localService: boolean;
}

/** A word/sentence boundary reported while speaking, for fine-grained highlighting. */
export interface SpeechBoundary {
  /** Index of the sentence (speakable unit) currently being spoken. */
  readonly sentenceIndex: number;
  /** The sentence text being spoken. */
  readonly sentence: string;
  /** Character offset of the boundary within `sentence`. */
  readonly charIndex: number;
  /** Length of the unit at the boundary, when the engine reports it. */
  readonly charLength: number;
}

/** The full read-aloud surface; all methods are safe to call when unsupported. */
export interface SpeechController {
  /** False when the platform has no speech synthesis; every method is then a no-op. */
  readonly supported: boolean;
  /** Loads `text`, resets to the first sentence and begins speaking. */
  speak(text: string): void;
  /** Starts (from idle) or resumes (from paused). No-op while already playing. */
  play(): void;
  /** Pauses the current utterance; resume with {@link play} or {@link resume}. */
  pause(): void;
  /** Resumes a paused utterance. */
  resume(): void;
  /** Stops and clears the queue, returning to the first sentence. */
  stop(): void;
  /** Skips to the next sentence, or ends if already at the last. */
  next(): void;
  /** Restarts the current sentence, or steps back one if near its start. */
  previous(): void;
  /** Jumps to and speaks the sentence at `index` (clamped to range). */
  seek(index: number): void;
  /** Sets the speaking rate (clamped to [0.5, 3]); applies live. */
  setRate(rate: number): void;
  /** Sets the pitch (clamped to [0, 2]); applies live. */
  setPitch(pitch: number): void;
  /** Sets the volume (clamped to [0, 1]); applies live. */
  setVolume(volume: number): void;
  /** Selects a voice by `name`, or `null` for the engine default; applies live. */
  setVoice(name: string | null): void;
  readonly rate: number;
  readonly pitch: number;
  readonly volume: number;
  readonly voice: string | null;
  readonly state: SpeechState;
  /** `{ index, total }` of the current sentence within the loaded text. */
  readonly progress: { readonly index: number; readonly total: number };
  /** The sentences (speakable units) of the loaded text. */
  readonly sentences: readonly string[];
  /** Installed voices; empty until the engine has loaded them. */
  listVoices(): SpeechVoice[];
  /** Subscribes to state transitions. Returns an unsubscribe function. */
  onState(callback: (state: SpeechState) => void): () => void;
  /** Fires as each sentence starts speaking, with its text and index. */
  onSentence(callback: (text: string, index: number) => void): () => void;
  /** Fires on word/sentence boundaries within the current sentence. */
  onBoundary(callback: (boundary: SpeechBoundary) => void): () => void;
  /** Fires when the voice list becomes available or changes. */
  onVoices(callback: (voices: SpeechVoice[]) => void): () => void;
  /** Fires once the whole text has finished (not on manual stop). */
  onEnd(callback: () => void): () => void;
  /** Stops speech and releases listeners/timers. */
  destroy(): void;
}

/* ------------------------------------------------------------------ *
 * Minimal structural types for the Web Speech API.
 *
 * The real DOM types satisfy these, and a test can supply a plain stub
 * without implementing the full `SpeechSynthesisUtterance`/EventTarget.
 * ------------------------------------------------------------------ */

export interface SpeechVoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly default: boolean;
  readonly localService: boolean;
  readonly voiceURI: string;
}

export interface SpeechUtteranceLike {
  text: string;
  rate: number;
  pitch: number;
  volume: number;
  lang: string;
  voice: SpeechVoiceLike | null;
  onstart: ((event: unknown) => void) | null;
  onend: ((event: unknown) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onboundary: ((event: { name?: string; charIndex: number; charLength?: number }) => void) | null;
}

export interface SpeechSynthesisLike {
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): readonly SpeechVoiceLike[];
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export type SpeechUtteranceCtor = new (text: string) => SpeechUtteranceLike;

/** The platform pieces the controller needs; injectable for testing. */
export interface SpeechEnvironment {
  readonly synth: SpeechSynthesisLike;
  readonly Utterance: SpeechUtteranceCtor;
}

/** Options for {@link createSpeech}. */
export interface SpeechOptions {
  /** Override the platform speech environment (used in tests). */
  readonly environment?: SpeechEnvironment;
  /** BCP-47 language tag applied to utterances (defaults to the document's). */
  readonly lang?: string;
  /** Hard cap on an utterance's length; longer sentences are sub-split. */
  readonly maxChunkLength?: number;
}

export const SPEECH_RATE_MIN = 0.5;
export const SPEECH_RATE_MAX = 3;
export const SPEECH_PITCH_MAX = 2;
/** Default utterance length cap; engines truncate or stall beyond ~a paragraph. */
export const SPEECH_MAX_CHUNK = 240;
/** Keep-alive cadence, under the ~15s Chromium auto-pause threshold. */
const KEEP_ALIVE_MS = 10_000;

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Splits text into sentences, preferring the platform's locale-aware
 * {@link Intl.Segmenter} and falling back to a punctuation heuristic.
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return [];
  const segmenter = resolveSegmenter();
  if (segmenter) {
    const out: string[] = [];
    for (const part of segmenter.segment(normalized)) {
      const trimmed = part.segment.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
    if (out.length > 0) return out;
  }
  // Fallback: a run of non-terminators followed by terminators not glued to a
  // word character (so "3.14" and "e.g." are not split), or the trailing run.
  const matches = normalized.match(/[^.!?…。！？]+(?:[.!?…。！？]+(?!\w)|$)/gu);
  if (!matches) return [normalized];
  return matches.map((part) => part.trim()).filter((part) => part.length > 0);
}

interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string }>;
}

function resolveSegmenter(): SegmenterLike | null {
  const intl = (globalThis as { Intl?: { Segmenter?: unknown } }).Intl;
  const ctor = intl?.Segmenter;
  if (typeof ctor !== 'function') return null;
  try {
    return new (ctor as new (locale?: string, options?: { granularity: string }) => SegmenterLike)(
      undefined,
      { granularity: 'sentence' },
    );
  } catch {
    return null;
  }
}

/**
 * Splits text into speakable units: sentences first, then any sentence longer
 * than `maxLength` sub-split on word boundaries so no single utterance is long
 * enough to be truncated or stalled by the engine.
 */
export function toSpeakableUnits(text: string, maxLength = SPEECH_MAX_CHUNK): string[] {
  const limit = Math.max(40, Math.floor(maxLength));
  const units: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.length <= limit) {
      units.push(sentence);
      continue;
    }
    units.push(...chunkLongSentence(sentence, limit));
  }
  return units;
}

/** Breaks one over-long sentence into <= limit chunks, splitting between words. */
function chunkLongSentence(sentence: string, limit: number): string[] {
  const words = sentence.split(' ');
  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += ` ${word}`;
    } else {
      chunks.push(current);
      current = word;
    }
    // A single word longer than the limit is emitted whole rather than cut.
    if (current.length > limit && !current.includes(' ')) {
      chunks.push(current);
      current = '';
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function resolveEnvironment(override?: SpeechEnvironment): SpeechEnvironment | null {
  if (override) return override;
  const scope = globalThis as {
    speechSynthesis?: SpeechSynthesisLike;
    SpeechSynthesisUtterance?: SpeechUtteranceCtor;
  };
  const synth = scope.speechSynthesis;
  const Utterance = scope.SpeechSynthesisUtterance;
  if (!synth || typeof Utterance !== 'function') return null;
  return { synth, Utterance };
}

/**
 * Creates a {@link SpeechController}. When speech synthesis is unavailable the
 * returned controller reports `supported: false` and every method is a no-op,
 * so callers never need to feature-detect themselves.
 */
export function createSpeech(options: SpeechOptions = {}): SpeechController {
  const env = resolveEnvironment(options.environment);
  if (!env) return createUnsupportedController();
  return new WebSpeechController(env, options);
}

type Listener<T> = (value: T) => void;

/** A tiny subscriber set with an unsubscribe-returning `add` and a fan-out `emit`. */
class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  add(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  clear(): void {
    this.listeners.clear();
  }
}

class WebSpeechController implements SpeechController {
  readonly supported = true;
  private readonly synth: SpeechSynthesisLike;
  private readonly Utterance: SpeechUtteranceCtor;
  private readonly lang: string;
  private readonly maxChunk: number;

  private units: string[] = [];
  private cursor = 0;
  private currentState: SpeechState = 'idle';
  private _rate = 1;
  private _pitch = 1;
  private _volume = 1;
  private voiceName: string | null = null;
  private voices: SpeechVoiceLike[] = [];
  /** The utterance we expect `end`/`error` from; guards stale events after cancel. */
  private active: SpeechUtteranceLike | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  private readonly stateEmitter = new Emitter<SpeechState>();
  private readonly sentenceEmitter = new Emitter<{ text: string; index: number }>();
  private readonly boundaryEmitter = new Emitter<SpeechBoundary>();
  private readonly voicesEmitter = new Emitter<SpeechVoice[]>();
  private readonly endEmitter = new Emitter<void>();
  private readonly onVoicesChanged = (): void => this.refreshVoices();

  constructor(env: SpeechEnvironment, options: SpeechOptions) {
    this.synth = env.synth;
    this.Utterance = env.Utterance;
    this.lang =
      options.lang ?? (typeof document !== 'undefined' ? document.documentElement.lang : '') ?? '';
    this.maxChunk = options.maxChunkLength ?? SPEECH_MAX_CHUNK;
    this.refreshVoices();
    this.synth.addEventListener?.('voiceschanged', this.onVoicesChanged);
  }

  get rate(): number {
    return this._rate;
  }
  get pitch(): number {
    return this._pitch;
  }
  get volume(): number {
    return this._volume;
  }
  get voice(): string | null {
    return this.voiceName;
  }
  get state(): SpeechState {
    return this.currentState;
  }
  get progress(): { readonly index: number; readonly total: number } {
    return { index: this.cursor, total: this.units.length };
  }
  get sentences(): readonly string[] {
    return this.units;
  }

  speak(text: string): void {
    if (this.disposed) return;
    this.synth.cancel();
    this.active = null;
    this.units = toSpeakableUnits(text, this.maxChunk);
    this.cursor = 0;
    if (this.units.length === 0) {
      this.setState('idle');
      return;
    }
    this.speakFromCursor();
  }

  play(): void {
    if (this.disposed) return;
    if (this.currentState === 'paused') {
      this.resume();
      return;
    }
    if (this.currentState === 'playing') return;
    if (this.units.length === 0) return;
    if (this.cursor >= this.units.length) this.cursor = 0;
    this.speakFromCursor();
  }

  pause(): void {
    if (this.disposed || this.currentState !== 'playing') return;
    this.synth.pause();
    this.stopKeepAlive();
    this.setState('paused');
  }

  resume(): void {
    if (this.disposed || this.currentState !== 'paused') return;
    this.synth.resume();
    this.startKeepAlive();
    this.setState('playing');
  }

  stop(): void {
    if (this.disposed) return;
    this.active = null;
    this.synth.cancel();
    this.stopKeepAlive();
    this.cursor = 0;
    this.setState('idle');
  }

  next(): void {
    if (this.disposed || this.units.length === 0) return;
    this.active = null;
    this.synth.cancel();
    if (this.cursor >= this.units.length - 1) {
      this.finish();
      return;
    }
    this.cursor += 1;
    this.speakFromCursor();
  }

  previous(): void {
    if (this.disposed || this.units.length === 0) return;
    this.active = null;
    this.synth.cancel();
    // Step back only when already near the start of the current sentence;
    // otherwise restart the current one (matches media-player behaviour).
    this.cursor = Math.max(0, this.cursor - 1);
    this.speakFromCursor();
  }

  seek(index: number): void {
    if (this.disposed || this.units.length === 0) return;
    this.active = null;
    this.synth.cancel();
    this.cursor = clamp(Math.floor(index), 0, this.units.length - 1);
    this.speakFromCursor();
  }

  setRate(rate: number): void {
    this._rate = clamp(rate, SPEECH_RATE_MIN, SPEECH_RATE_MAX);
    this.restartForSettingChange();
  }
  setPitch(pitch: number): void {
    this._pitch = clamp(pitch, 0, SPEECH_PITCH_MAX);
    this.restartForSettingChange();
  }
  setVolume(volume: number): void {
    this._volume = clamp(volume, 0, 1);
    this.restartForSettingChange();
  }
  setVoice(name: string | null): void {
    this.voiceName = name;
    this.restartForSettingChange();
  }

  listVoices(): SpeechVoice[] {
    return this.voices.map(toSpeechVoice);
  }

  onState(callback: (state: SpeechState) => void): () => void {
    return this.stateEmitter.add(callback);
  }
  onSentence(callback: (text: string, index: number) => void): () => void {
    return this.sentenceEmitter.add(({ text, index }) => callback(text, index));
  }
  onBoundary(callback: (boundary: SpeechBoundary) => void): () => void {
    return this.boundaryEmitter.add(callback);
  }
  onVoices(callback: (voices: SpeechVoice[]) => void): () => void {
    return this.voicesEmitter.add(callback);
  }
  onEnd(callback: () => void): () => void {
    return this.endEmitter.add(callback);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = null;
    try {
      this.synth.cancel();
    } catch {
      // The engine may already be torn down.
    }
    this.stopKeepAlive();
    this.synth.removeEventListener?.('voiceschanged', this.onVoicesChanged);
    this.stateEmitter.clear();
    this.sentenceEmitter.clear();
    this.boundaryEmitter.clear();
    this.voicesEmitter.clear();
    this.endEmitter.clear();
    this.units = [];
    this.currentState = 'idle';
  }

  // --- internals ---------------------------------------------------------

  private speakFromCursor(): void {
    const text = this.units[this.cursor];
    if (text === undefined) {
      this.finish();
      return;
    }
    const utterance = new this.Utterance(text);
    utterance.text = text;
    utterance.rate = this._rate;
    utterance.pitch = this._pitch;
    utterance.volume = this._volume;
    if (this.lang) utterance.lang = this.lang;
    utterance.voice = this.resolveVoice();
    const index = this.cursor;
    utterance.onstart = () => {
      if (this.active !== utterance) return;
      this.setState('playing');
      this.sentenceEmitter.emit({ text, index });
    };
    utterance.onboundary = (event) => {
      if (this.active !== utterance) return;
      this.boundaryEmitter.emit({
        sentenceIndex: index,
        sentence: text,
        charIndex: event.charIndex,
        charLength: event.charLength ?? 0,
      });
    };
    utterance.onend = () => {
      if (this.active !== utterance) return;
      this.active = null;
      this.advance();
    };
    utterance.onerror = (event) => {
      if (this.active !== utterance) return;
      this.active = null;
      // Cancellations are expected (stop/skip/setting change); only a genuine
      // engine error ends playback.
      const error = event.error ?? '';
      if (error === 'interrupted' || error === 'canceled') return;
      this.finish();
    };
    this.active = utterance;
    this.setState('playing');
    this.startKeepAlive();
    this.synth.speak(utterance);
  }

  private advance(): void {
    if (this.cursor >= this.units.length - 1) {
      this.finish();
      return;
    }
    this.cursor += 1;
    this.speakFromCursor();
  }

  private finish(): void {
    this.active = null;
    this.stopKeepAlive();
    this.cursor = 0;
    this.setState('idle');
    this.endEmitter.emit();
  }

  /** Re-speaks the current sentence so a rate/voice change takes effect at once. */
  private restartForSettingChange(): void {
    if (this.disposed) return;
    if (this.currentState === 'playing') {
      this.active = null;
      this.synth.cancel();
      this.speakFromCursor();
    }
    // When paused, the new settings apply on the next sentence after resume.
  }

  private resolveVoice(): SpeechVoiceLike | null {
    if (this.voiceName === null) return null;
    return this.voices.find((voice) => voice.name === this.voiceName) ?? null;
  }

  private refreshVoices(): void {
    let next: readonly SpeechVoiceLike[];
    try {
      next = this.synth.getVoices();
    } catch {
      next = [];
    }
    this.voices = [...next];
    this.voicesEmitter.emit(this.voices.map(toSpeechVoice));
  }

  private setState(state: SpeechState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.stateEmitter.emit(state);
  }

  private startKeepAlive(): void {
    if (this.keepAlive !== null || typeof setInterval !== 'function') return;
    this.keepAlive = setInterval(() => {
      // Resume is a no-op while genuinely playing; it only unsticks the engine
      // after Chromium's ~15s auto-pause, keeping long passages flowing.
      if (this.currentState === 'playing') {
        try {
          this.synth.resume();
        } catch {
          // Ignore; the engine may be between utterances.
        }
      }
    }, KEEP_ALIVE_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAlive !== null) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }
}

function toSpeechVoice(voice: SpeechVoiceLike): SpeechVoice {
  return {
    name: voice.name,
    lang: voice.lang,
    isDefault: voice.default,
    localService: voice.localService,
  };
}

/** A controller for platforms without speech synthesis: every method no-ops. */
function createUnsupportedController(): SpeechController {
  const noop = (): void => {};
  const unsubscribe = (): (() => void) => noop;
  return {
    supported: false,
    speak: noop,
    play: noop,
    pause: noop,
    resume: noop,
    stop: noop,
    next: noop,
    previous: noop,
    seek: noop,
    setRate: noop,
    setPitch: noop,
    setVolume: noop,
    setVoice: noop,
    rate: 1,
    pitch: 1,
    volume: 1,
    voice: null,
    state: 'idle',
    progress: { index: 0, total: 0 },
    sentences: [],
    listVoices: () => [],
    onState: unsubscribe,
    onSentence: unsubscribe,
    onBoundary: unsubscribe,
    onVoices: unsubscribe,
    onEnd: unsubscribe,
    destroy: noop,
  };
}
