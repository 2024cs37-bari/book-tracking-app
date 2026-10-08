import { A } from '@solidjs/router';

export default function NotFoundView() {
  return (
    <section class="empty-state">
      <h2>Page not found</h2>
      <p>That page does not exist in this application.</p>
      <A class="button button-primary" href="/">
        Back to library
      </A>
    </section>
  );
}
