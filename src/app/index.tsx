/* @refresh reload */
import { render } from 'solid-js/web';
import App from './App';
import { AppProvider } from './context';
import { createAppServices } from './services';
import '~/styles/global.css';

const root = document.getElementById('root');

function renderFatal(message: string, detail?: string): void {
  if (root === null) return;
  root.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'fatal-error';

  const heading = document.createElement('h1');
  heading.textContent = message;
  container.append(heading);

  if (detail !== undefined) {
    const paragraph = document.createElement('p');
    paragraph.textContent = detail;
    container.append(paragraph);
  }

  const hint = document.createElement('p');
  hint.textContent =
    'The library is stored locally in this browser. Nothing has been uploaded or changed.';
  container.append(hint);

  root.append(container);
}

async function boot(): Promise<void> {
  if (root === null) {
    throw new Error('The #root element is missing from index.html.');
  }

  try {
    const services = await createAppServices();

    // Persist the clock when the app is hidden so a restart cannot reissue an
    // HLC that was already used. Deferred to the sync engine to make finer.
    const persistClock = (): void => {
      void services.persistClockState();
    };
    window.addEventListener('pagehide', persistClock);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistClock();
    });

    render(
      () => (
        <AppProvider services={services}>
          <App />
        </AppProvider>
      ),
      root,
    );
  } catch (error) {
    renderFatal(
      'The library could not be opened.',
      error instanceof Error ? error.message : 'Unknown error.',
    );
  }
}

void boot();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .catch((error: unknown) => {
      const note = document.createElement('p');
      note.className = 'note note-warning';
      note.textContent = `Offline app caching failed: ${String(error)}. Local books are still stored.`;
      document.body.append(note);
    });
}
