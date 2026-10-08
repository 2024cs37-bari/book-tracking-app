import { A, useParams } from '@solidjs/router';
import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { useApp } from '~/app/context';
import type { ReaderSettings, ReaderTheme, TocItem } from '~/reader/renderer';
import type { ReaderSession } from '~/services/reader-service';
import ReaderContents from './ReaderContents';

export default function ReaderView() {
  const app = useApp();
  const params = useParams();
  const [title, setTitle] = createSignal('Reader');
  const [message, setMessage] = createSignal('Opening book…');
  const [ready, setReady] = createSignal(false);
  const [fraction, setFraction] = createSignal(0);
  const [settings, setSettings] = createSignal(app.reader.loadSettings());
  const [toc, setToc] = createSignal<readonly TocItem[]>([]);
  const [tocLoading, setTocLoading] = createSignal(true);
  const [tocError, setTocError] = createSignal('');
  let host!: HTMLDivElement;
  let session: ReaderSession | undefined;

  function updateSettings(patch: Partial<ReaderSettings>): void {
    const next = { ...settings(), ...patch };
    setSettings(next);
    session?.renderer.applySettings(next);
    try {
      app.reader.saveSettings(next);
    } catch (error) {
      setMessage(`Settings could not be saved: ${String(error)}`);
    }
  }

  createEffect(() => {
    const id = params.id ?? '';
    let disposed = false;
    let current: ReaderSession | undefined;
    setReady(false);
    setToc([]);
    setTocLoading(true);
    setTocError('');
    const readerMessage = (event: Event) => setMessage(String((event as CustomEvent).detail));
    const flush = () => {
      void current?.flush();
    };
    host.addEventListener('reader-message', readerMessage);
    window.addEventListener('pagehide', flush);
    const visibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', visibility);
    void app.reader
      .prepare(id, setMessage)
      .then(async (prepared) => {
        if (disposed) {
          await prepared.session.close();
          return;
        }
        current = prepared.session;
        session = current;
        setTitle(prepared.title);
        current.renderer.mount(host);
        current.renderer.applySettings(app.reader.loadSettings());
        setMessage('');
        await current.open(prepared.file, prepared.startAt, (locator) =>
          setFraction(locator.fraction),
        );
        if (disposed) return;
        setReady(true);
        // Contents are optional: their parsing must not delay basic reading.
        try {
          const items = await current.renderer.getToc();
          if (!disposed) setToc(items);
        } catch (error) {
          if (!disposed) setTocError(`Contents could not be loaded: ${String(error)}`);
        } finally {
          if (!disposed) setTocLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setMessage(`Could not open book: ${String(error)}`);
      });
    onCleanup(() => {
      disposed = true;
      session = undefined;
      host.removeEventListener('reader-message', readerMessage);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', visibility);
      void current?.close();
    });
  });

  return (
    <section class="reader-shell">
      <div class="reader-toolbar">
        <A href={`/book/${params.id}`}>← Close reader</A>
        <h2>{title()}</h2>
        <span aria-label="Reading progress">{Math.round(fraction() * 100)}%</span>
        <button class="button" disabled={!ready()} onClick={() => session?.renderer.prev()}>
          Previous
        </button>
        <button class="button" disabled={!ready()} onClick={() => session?.renderer.next()}>
          Next
        </button>
        <details>
          <summary>Reader settings</summary>
          <div class="reader-settings">
            <label>
              Font size / PDF zoom
              <input
                aria-label="Font size / PDF zoom"
                type="range"
                min="12"
                max="36"
                value={settings().fontSizePx}
                onInput={(event) =>
                  updateSettings({ fontSizePx: Number(event.currentTarget.value) })
                }
              />
            </label>
            <label>
              Line height
              <input
                aria-label="Line height"
                type="range"
                min="1"
                max="2.5"
                step="0.1"
                value={settings().lineHeight}
                onInput={(event) =>
                  updateSettings({ lineHeight: Number(event.currentTarget.value) })
                }
              />
            </label>
            <label>
              Margins
              <input
                aria-label="Margins"
                type="range"
                min="0"
                max="80"
                value={settings().marginPx}
                onInput={(event) => updateSettings({ marginPx: Number(event.currentTarget.value) })}
              />
            </label>
            <label>
              Theme
              <select
                aria-label="Theme"
                value={settings().theme}
                onChange={(event) =>
                  updateSettings({ theme: event.currentTarget.value as ReaderTheme })
                }
              >
                <option value="light">Light</option>
                <option value="sepia">Sepia</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </div>
        </details>
      </div>
      <Show when={ready()}>
        <ReaderContents
          items={toc()}
          loading={tocLoading()}
          error={tocError()}
          onSelect={(locator) => session?.renderer.goTo(locator)}
        />
      </Show>
      <Show when={message()}>
        <p class="note" role="status">
          {message()}
        </p>
      </Show>
      <div
        class="reader-surface"
        ref={(element) => {
          host = element;
        }}
      />
    </section>
  );
}
