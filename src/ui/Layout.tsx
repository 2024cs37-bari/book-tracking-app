import { A, useLocation } from '@solidjs/router';
import { createEffect, onCleanup, Show, type ParentProps } from 'solid-js';
import { useApp } from '~/app/context';
import { Toaster } from './toast';
import OfflineAppStatus from './OfflineAppStatus';
import Icon from './Icon';

export default function Layout(props: ParentProps) {
  const app = useApp();
  const location = useLocation();
  // The reader fills the screen; every other route is a centered column.
  const isReader = () => location.pathname.startsWith('/read');
  // Lock the document scroll in the reader so a stray overflow (e.g. pdf.js's
  // body-mounted measurement canvas) can never raise a window scrollbar and make
  // the whole shell shake. Toggled on <html> so it survives the focused shell.
  createEffect(() => {
    document.documentElement.classList.toggle('reader-locked', isReader());
  });
  onCleanup(() => document.documentElement.classList.remove('reader-locked'));

  return (
    <div class="app-shell">
      <a
        class="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('main');
          main?.focus({ preventScroll: true });
          main?.scrollIntoView({ block: 'start' });
        }}
      >
        Skip to content
      </a>

      {/* The reader is a focused shell: its own toolbar is the only chrome, so
          the app header, nav and footer are hidden on the reader route. */}
      <Show when={!isReader()}>
        <header class="app-header">
          <A class="app-title" href="/">
            <Icon name="book" size={24} />
            <span>
              Book Reader<span class="app-title-caption">A personal library</span>
            </span>
          </A>
          <nav class="app-nav" aria-label="Main">
            <A href="/" end>
              Library
            </A>
            <A href="/stats">Stats</A>
            <A href="/settings">Settings</A>
          </nav>
        </header>

        <Show when={app.storageWarning}>
          {(warning) => (
            <p class="banner banner-warning" role="status">
              <strong>Storage notice:</strong> {warning()}
              <Show when={!app.files.durable}>
                {' '}
                Books imported now will be lost when this page is closed. Export your originals
                before leaving, or use a browser with local storage enabled.
              </Show>
            </p>
          )}
        </Show>
      </Show>

      <main id="main" tabIndex={-1} class="app-main" classList={{ 'app-main-reader': isReader() }}>
        {props.children}
      </main>

      <Show when={!isReader()}>
        <footer class="app-footer">
          <OfflineAppStatus />
          <p class="footer-privacy">
            <span class="status-dot" aria-hidden="true" />
            Your books, your space.{' '}
            <A href="/settings#settings-backups">
              Back up your library <Icon name="arrow-right" size={14} />
            </A>
          </p>
        </footer>
      </Show>
      <Toaster />
    </div>
  );
}
