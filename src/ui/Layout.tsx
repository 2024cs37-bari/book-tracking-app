import { A } from '@solidjs/router';
import { Show, type ParentProps } from 'solid-js';
import { useApp } from '~/app/context';

export default function Layout(props: ParentProps) {
  const app = useApp();

  return (
    <div class="app-shell">
      <a class="skip-link" href="#main">
        Skip to content
      </a>

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

      <main id="main" class="app-main">
        {props.children}
      </main>

      <footer class="app-footer">
        <p>
          Local-first: your library lives in this browser. Nothing is sent anywhere until sync is
          configured.
        </p>
      </footer>
    </div>
  );
}
