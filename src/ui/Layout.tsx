import { A, useLocation } from '@solidjs/router';
import { createEffect, onCleanup, Show, type ParentProps } from 'solid-js';
import { useApp } from '~/app/context';
import { Toaster } from './toast';

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
      <a class="skip-link" href="#main">
        Skip to content
      </a>

      {/* The reader is a focused shell: its own toolbar is the only chrome, so
          the app header, nav and footer are hidden on the reader route. */}
      <Show when={!isReader()}>
        <header class="app-header">
          <A class="app-title" href="/">
            Personal Book Reader
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
              <strong>Storage limitation:</strong> {warning()} Books imported now are kept in memory
              only and will be lost when this page is closed. Browser storage may be unavailable in
              private windows or when site data is blocked.
            </p>
          )}
        </Show>
      </Show>

      <main id="main" class="app-main" classList={{ 'app-main-reader': isReader() }}>
        {props.children}
      </main>

      <Show when={!isReader()}>
        <footer class="app-footer">
          <p>
            Local-first: your library lives in this browser. Nothing is sent anywhere until sync is
            configured.
          </p>
        </footer>
      </Show>
      <Toaster />
    </div>
  );
}
