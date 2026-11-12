/* @refresh reload */
import { render } from 'solid-js/web';
import App from './App';
import { AppProvider } from './context';
import { createAppServices } from './services';
import { initTheme } from '~/ui/theme';
import { registerOfflineApp } from './service-worker';
import { isNativeRuntime } from '~/storage/native-file-store';
import { installNativeCloseHandling, registerNativeCloseGuard } from './native-lifecycle';
import { readingActivityQueue } from '~/services/reading-activity';
import '~/styles/global.css';
import '~/styles/motion.css';

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

  // Apply the saved theme/accent before first paint to avoid a flash.
  initTheme();

  try {
    const services = await createAppServices();

    if (isNativeRuntime()) {
      registerNativeCloseGuard(async () => {
        let saved = true;
        await readingActivityQueue(services.sessions, services.persistClockState).flush((error) => {
          if (error) saved = false;
        });
        await services.persistClockState();
        return saved;
      });
      await installNativeCloseHandling();
    }

    // Background work starts after local initialization and never blocks rendering.
    services.background?.start();

    // Extra checkpoint; startup also recovers every committed entity/outbox HLC.
    const persistClock = (): void => {
      void services.persistClockState().catch(() => {
        /* Boot recovers committed HLCs. */
      });
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

if (import.meta.env.PROD) void registerOfflineApp();
