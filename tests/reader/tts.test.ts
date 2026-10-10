// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSpeech,
  splitSentences,
  toSpeakableUnits,
  type SpeechEnvironment,
  type SpeechSynthesisLike,
  type SpeechUtteranceLike,
  type SpeechVoiceLike,
} from '~/reader/tts';

/* ------------------------------------------------------------------ *
 * A stub Web Speech engine that drives utterance lifecycle manually, so
 * tests can step through sentences deterministically without a real
 * speech synthesiser.
 * ------------------------------------------------------------------ */
class StubUtterance implements SpeechUtteranceLike {
  text = '';
  rate = 1;
  pitch = 1;
  volume = 1;
  lang = '';
  voice: SpeechVoiceLike | null = null;
  onstart: ((event: unknown) => void) | null = null;
  onend: ((event: unknown) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onboundary: ((event: { name?: string; charIndex: number; charLength?: number }) => void) | null =
    null;
  constructor(text: string) {
    this.text = text;
  }
}

class StubSynth implements SpeechSynthesisLike {
  spoken: StubUtterance[] = [];
  current: StubUtterance | null = null;
  paused = false;
  resumeCount = 0;
  cancelCount = 0;
  private voices: SpeechVoiceLike[];
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(voices: SpeechVoiceLike[] = []) {
    this.voices = voices;
  }
  speak(utterance: SpeechUtteranceLike): void {
    const stub = utterance as StubUtterance;
    this.current = stub;
    this.spoken.push(stub);
    this.paused = false;
    // Emulate the engine firing `start` as soon as it dequeues the utterance.
    stub.onstart?.(undefined);
  }
  cancel(): void {
    this.cancelCount += 1;
    const previous = this.current;
    this.current = null;
    this.paused = false;
    // The spec fires an `error: 'canceled'` on a cancelled utterance.
    previous?.onerror?.({ error: 'canceled' });
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.resumeCount += 1;
    this.paused = false;
  }
  getVoices(): readonly SpeechVoiceLike[] {
    return this.voices;
  }
  addEventListener(type: string, listener: () => void): void {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  // --- test helpers ---
  setVoices(voices: SpeechVoiceLike[]): void {
    this.voices = voices;
    for (const listener of this.listeners.get('voiceschanged') ?? []) listener();
  }
  /** Completes the utterance currently being "spoken". */
  finishCurrent(): void {
    const utterance = this.current;
    this.current = null;
    utterance?.onend?.(undefined);
  }
}

function voice(name: string, lang = 'en-US', isDefault = false): SpeechVoiceLike {
  return { name, lang, default: isDefault, localService: true, voiceURI: name };
}

function makeEnv(synth: StubSynth): SpeechEnvironment {
  return { synth, Utterance: StubUtterance };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('splitSentences', () => {
  it('splits on sentence terminators and trims each sentence', () => {
    const result = splitSentences('Hello world. How are you? I am fine!');
    expect(result).toEqual(['Hello world.', 'How are you?', 'I am fine!']);
  });

  it('collapses whitespace and ignores empty input', () => {
    expect(splitSentences('   \n  ')).toEqual([]);
    expect(splitSentences('One.\n\n  Two.')).toEqual(['One.', 'Two.']);
  });

  it('keeps a terminator-free fragment as a single sentence', () => {
    expect(splitSentences('no terminator here')).toEqual(['no terminator here']);
  });
});

describe('toSpeakableUnits', () => {
  it('keeps short sentences whole', () => {
    expect(toSpeakableUnits('A. B. C.')).toEqual(['A.', 'B.', 'C.']);
  });

  it('sub-splits an over-long sentence on word boundaries under the cap', () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
    const units = toSpeakableUnits(`${words}.`, 60);
    expect(units.length).toBeGreaterThan(1);
    for (const unit of units) expect(unit.length).toBeLessThanOrEqual(60);
    // Every word survives the chunking.
    expect(units.join(' ').replace('.', '')).toContain('word39');
  });
});

describe('createSpeech', () => {
  it('reports unsupported and no-ops when speech synthesis is absent', () => {
    const controller = createSpeech();
    expect(controller.supported).toBe(false);
    expect(controller.listVoices()).toEqual([]);
    expect(() => {
      controller.speak('hello');
      controller.play();
      controller.stop();
      controller.destroy();
    }).not.toThrow();
    expect(controller.state).toBe('idle');
  });

  it('speaks sentences sequentially, tracking the current sentence and state', () => {
    const synth = new StubSynth();
    const controller = createSpeech({ environment: makeEnv(synth) });
    const states: string[] = [];
    const sentences: Array<{ text: string; index: number }> = [];
    controller.onState((state) => states.push(state));
    controller.onSentence((text, index) => sentences.push({ text, index }));

    controller.speak('First sentence. Second sentence. Third sentence.');

    // Only the first utterance is queued; it is "playing" and reported.
    expect(controller.state).toBe('playing');
    expect(synth.spoken).toHaveLength(1);
    expect(sentences).toEqual([{ text: 'First sentence.', index: 0 }]);
    expect(controller.progress).toEqual({ index: 0, total: 3 });

    synth.finishCurrent();
    expect(sentences[1]).toEqual({ text: 'Second sentence.', index: 1 });
    expect(controller.progress.index).toBe(1);

    synth.finishCurrent();
    expect(sentences[2]).toEqual({ text: 'Third sentence.', index: 2 });

    const ended = vi.fn();
    controller.onEnd(ended);
    synth.finishCurrent();
    expect(ended).toHaveBeenCalledOnce();
    expect(controller.state).toBe('idle');
    // State transitions observed: playing (start) → idle (end).
    expect(states).toEqual(['playing', 'idle']);
  });

  it('pauses and resumes through the engine', () => {
    const synth = new StubSynth();
    const controller = createSpeech({ environment: makeEnv(synth) });
    controller.speak('One. Two.');
    controller.pause();
    expect(controller.state).toBe('paused');
    expect(synth.paused).toBe(true);
    controller.resume();
    expect(controller.state).toBe('playing');
    expect(synth.paused).toBe(false);
    controller.destroy();
  });

  it('stops, clearing the queue and returning to the first sentence', () => {
    const synth = new StubSynth();
    const controller = createSpeech({ environment: makeEnv(synth) });
    controller.speak('One. Two. Three.');
    synth.finishCurrent();
    expect(controller.progress.index).toBe(1);
    controller.stop();
    expect(controller.state).toBe('idle');
    expect(controller.progress.index).toBe(0);
    expect(synth.cancelCount).toBeGreaterThan(0);
  });

  it('skips to the next sentence and restarts on previous', () => {
    const synth = new StubSynth();
    const controller = createSpeech({ environment: makeEnv(synth) });
    controller.speak('One. Two. Three.');
    controller.next();
    expect(controller.progress.index).toBe(1);
    expect(synth.current?.text).toBe('Two.');
    controller.previous();
    expect(controller.progress.index).toBe(0);
    expect(synth.current?.text).toBe('One.');
    controller.destroy();
  });

  it('applies rate and selected voice to the utterance and re-speaks live', () => {
    const synth = new StubSynth([voice('Alex'), voice('Samantha')]);
    const controller = createSpeech({ environment: makeEnv(synth) });
    expect(controller.listVoices().map((item) => item.name)).toEqual(['Alex', 'Samantha']);

    controller.setRate(1.5);
    controller.setVoice('Samantha');
    controller.speak('Only one.');
    expect(synth.current?.rate).toBe(1.5);
    expect(synth.current?.voice?.name).toBe('Samantha');

    // Changing the rate while playing re-speaks the current sentence at the new rate.
    const before = synth.spoken.length;
    controller.setRate(0.75);
    expect(synth.spoken.length).toBe(before + 1);
    expect(synth.current?.rate).toBe(0.75);
    controller.destroy();
  });

  it('clamps rate to the supported range', () => {
    const synth = new StubSynth();
    const controller = createSpeech({ environment: makeEnv(synth) });
    controller.setRate(99);
    expect(controller.rate).toBe(3);
    controller.setRate(0);
    expect(controller.rate).toBe(0.5);
    controller.destroy();
  });

  it('emits boundary events scoped to the current sentence', () => {
    const synth = new StubSynth();
    const controller = createSpeech({ environment: makeEnv(synth) });
    const boundaries: number[] = [];
    controller.onBoundary((boundary) => boundaries.push(boundary.charIndex));
    controller.speak('Hello there.');
    synth.current?.onboundary?.({ name: 'word', charIndex: 6, charLength: 5 });
    expect(boundaries).toEqual([6]);
    controller.destroy();
  });

  it('reacts to voiceschanged and notifies subscribers', () => {
    const synth = new StubSynth();
    const controller = createSpeech({ environment: makeEnv(synth) });
    const seen = vi.fn();
    controller.onVoices(seen);
    synth.setVoices([voice('Daniel', 'en-GB')]);
    expect(controller.listVoices().map((item) => item.name)).toEqual(['Daniel']);
    expect(seen).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: 'Daniel', lang: 'en-GB' }),
    ]);
    controller.destroy();
  });

  it('ignores stale end events after a cancel', () => {
    const synth = new StubSynth();
    const controller = createSpeech({ environment: makeEnv(synth) });
    controller.speak('One. Two.');
    const first = synth.current!;
    controller.stop();
    // A late `end` from the cancelled utterance must not advance anything.
    first.onend?.(undefined);
    expect(controller.state).toBe('idle');
    expect(controller.progress.index).toBe(0);
    controller.destroy();
  });
});
