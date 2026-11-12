import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import {
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  type SpeechController,
  type SpeechState,
  type SpeechVoice,
} from '~/reader/tts';
import Icon from './Icon';
import Select from './Select';

export interface ReaderTtsProps {
  /** The read-aloud controller, e.g. from `createSpeech()`. */
  readonly controller: SpeechController;
  /**
   * Supplies the text to narrate when playback starts from idle — typically the
   * renderer's `getVisibleText()`. Called each time Play is pressed from idle so
   * the current page/section is read.
   */
  readonly getText: () => Promise<string>;
  /** Optional label for the control group. */
  readonly label?: string;
}

const RATE_STEP = 0.1;

/**
 * A compact read-aloud control: Play/Pause, Stop, a rate slider and a voice
 * picker, plus a live region showing the sentence currently being spoken. It is
 * a thin, reactive view over a {@link SpeechController}; all speech logic lives
 * in the controller so this component stays framework-glue only.
 */
export default function ReaderTts(props: ReaderTtsProps) {
  const [state, setState] = createSignal<SpeechState>('idle');
  const [voices, setVoices] = createSignal<SpeechVoice[]>([]);
  const [voice, setVoice] = createSignal<string>('');
  const [rate, setRate] = createSignal<number>(1);
  const [sentence, setSentence] = createSignal<string>('');
  const [progress, setProgress] = createSignal<{ index: number; total: number }>({
    index: 0,
    total: 0,
  });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(() => {
    const controller = props.controller;
    // Seed from the controller's current values, then track changes.
    setState(controller.state);
    setVoices(controller.listVoices());
    setVoice(controller.voice ?? '');
    setRate(controller.rate);
    setProgress({ ...controller.progress });
    const offState = controller.onState(setState);
    const offVoices = controller.onVoices(setVoices);
    const offSentence = controller.onSentence((text) => {
      setSentence(text);
      setProgress({ ...controller.progress });
    });
    const offEnd = controller.onEnd(() => {
      setSentence('');
      setProgress({ ...controller.progress });
    });
    onCleanup(() => {
      offState();
      offVoices();
      offSentence();
      offEnd();
    });
  });

  async function toggle(): Promise<void> {
    setError('');
    const controller = props.controller;
    const current = state();
    if (current === 'playing') {
      controller.pause();
      return;
    }
    if (current === 'paused') {
      controller.play();
      return;
    }
    // Idle: load the visible text and start narrating it.
    setBusy(true);
    try {
      const text = await props.getText();
      if (text.trim().length === 0) {
        setError('Nothing to read on this page.');
        return;
      }
      controller.speak(text);
    } catch {
      setError('Could not read this page aloud.');
    } finally {
      setBusy(false);
    }
  }

  function changeRate(value: number): void {
    setRate(value);
    props.controller.setRate(value);
  }

  function changeVoice(name: string): void {
    setVoice(name);
    props.controller.setVoice(name === '' ? null : name);
  }

  const playing = (): boolean => state() === 'playing';
  const active = (): boolean => state() !== 'idle';

  return (
    <Show
      when={props.controller.supported}
      fallback={
        <p class="note" role="status">
          Read-aloud is not available in this browser.
        </p>
      }
    >
      <section class="reader-tts" aria-label={props.label ?? 'Read aloud'}>
        <div class="reader-panel-intro">
          <h3>Listen to this page</h3>
          <p>Choose a voice and a comfortable pace.</p>
        </div>
        <div class="reader-tts-controls">
          <button
            type="button"
            class="button button-primary"
            aria-pressed={playing()}
            disabled={busy()}
            onClick={() => void toggle()}
          >
            {playing() ? 'Pause' : active() ? 'Resume' : busy() ? 'Loading…' : 'Play'}
          </button>
          <button
            type="button"
            class="button"
            disabled={!active()}
            onClick={() => props.controller.stop()}
          >
            Stop
          </button>
          <button
            type="button"
            class="reader-icon-button"
            aria-label="Previous sentence"
            disabled={!active()}
            onClick={() => props.controller.previous()}
          >
            <Icon name="arrow-left" size={17} />
          </button>
          <button
            type="button"
            class="reader-icon-button"
            aria-label="Next sentence"
            disabled={!active()}
            onClick={() => props.controller.next()}
          >
            <Icon name="arrow-right" size={17} />
          </button>
          <Show when={progress().total > 0}>
            <span class="note mono" aria-hidden="true">
              {progress().index + 1}/{progress().total}
            </span>
          </Show>
        </div>

        <label class="field reader-tts-speed">
          <span style={{ 'white-space': 'nowrap' }}>Speed</span>
          <input
            type="range"
            min={SPEECH_RATE_MIN}
            max={SPEECH_RATE_MAX}
            step={RATE_STEP}
            value={rate()}
            aria-label="Reading speed"
            onInput={(event) => changeRate(Number(event.currentTarget.value))}
            style={{ flex: '1' }}
          />
          <span class="mono" style={{ 'min-width': '3ch' }}>
            {rate().toFixed(1)}×
          </span>
        </label>

        <Show when={voices().length > 0}>
          <label class="field reader-tts-voice">
            <span style={{ 'white-space': 'nowrap' }}>Voice</span>
            <Select
              value={voice()}
              ariaLabel="Voice"
              onChange={changeVoice}
              options={[
                { value: '', label: 'Default' },
                ...voices().map((item) => ({
                  value: item.name,
                  label: `${item.name} (${item.lang})`,
                })),
              ]}
            />
          </label>
        </Show>

        <Show when={error()}>
          <p class="note note-error" role="alert" style={{ margin: 0 }}>
            {error()}
          </p>
        </Show>

        <p
          class="note"
          aria-live="polite"
          style={{
            margin: 0,
            'min-height': '1.4em',
            'font-style': sentence() ? 'italic' : 'normal',
          }}
        >
          {sentence()}
        </p>
      </section>
    </Show>
  );
}
