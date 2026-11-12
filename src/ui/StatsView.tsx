import { createResource, For, Show } from 'solid-js';
import { A } from '@solidjs/router';
import Icon from './Icon';
import '~/styles/stats-refinement.css';
import { useApp } from '~/app/context';
import type { ReadingStats } from '~/domain/session';
import { useLibraryRevision } from './use-library-revision';

interface StatsData {
  readonly stats: ReadingStats;
  readonly titles: ReadonlyMap<string, string>;
  readonly finishedBooks: number;
}

export default function StatsView() {
  const app = useApp();
  const revision = useLibraryRevision();

  const [data] = createResource<StatsData, number>(revision, async () => {
    const [stats, books, progress] = await Promise.all([
      app.sessions.stats(),
      app.books.list({ lifecycle: 'all' }),
      app.progress.listAll(),
    ]);
    const titles = new Map(books.map((book) => [book.id, book.title]));
    const finishedBooks = progress.filter(
      (row) => row.status === 'finished' && titles.has(row.bookId),
    ).length;
    return { stats, titles, finishedBooks };
  });

  return (
    <section class="stats">
      <header class="stats-heading">
        <p class="stats-eyebrow">Your reading life</p>
        <h1>Reading statistics</h1>
        <p>A little time with a good book adds up.</p>
      </header>

      <Show when={data.error}>
        <p class="note note-error" role="alert">
          Statistics could not be collected: {String(data.error)}
        </p>
      </Show>

      <Show when={data()} fallback={<p class="note">Collecting statistics…</p>}>
        {(loaded) => (
          <>
            <div class="stat-tiles">
              <div class="stat-tile stat-tile-featured">
                <span class="stat-value">{formatDuration(loaded().stats.totalSeconds)}</span>
                <span class="stat-label">Total time read</span>
              </div>
              <div class="stat-tile">
                <span class="stat-value">{loaded().stats.sessionCount}</span>
                <span class="stat-label">Sessions</span>
              </div>
              <div class="stat-tile">
                <span class="stat-value">{loaded().stats.booksRead}</span>
                <span class="stat-label">Books opened</span>
              </div>
              <div class="stat-tile">
                <span class="stat-value">{loaded().finishedBooks}</span>
                <span class="stat-label">Books finished</span>
              </div>
              <div class="stat-tile">
                <span class="stat-value">{loaded().stats.readingDays}</span>
                <span class="stat-label">Reading days</span>
              </div>
              <div class="stat-tile">
                <span class="stat-value">{loaded().stats.currentStreak}</span>
                <span class="stat-label">Current day streak</span>
              </div>
              <div class="stat-tile">
                <span class="stat-value">{loaded().stats.longestStreak}</span>
                <span class="stat-label">Longest day streak</span>
              </div>
            </div>

            <Show
              when={loaded().stats.perBook.size > 0}
              fallback={
                <div class="empty-state stats-empty">
                  <Icon name="book" size={32} />
                  <h2>No reading recorded yet</h2>
                  <p>Open a book and settle in. Your reading time will appear here.</p>
                  <A class="button button-primary" href="/">
                    Browse your library <Icon name="arrow-right" size={17} />
                  </A>
                </div>
              }
            >
              <div class="stats-content">
                <section class="stats-books">
                  <div class="stats-section-heading">
                    <h2>Time per book</h2>
                    <span>
                      {loaded().stats.perBook.size}{' '}
                      {loaded().stats.perBook.size === 1 ? 'book' : 'books'}
                    </span>
                  </div>
                  <ul class="stat-book-list">
                    <For each={sortedPerBook(loaded().stats)}>
                      {([bookId, seconds]) => (
                        <li class="stat-book-row">
                          <div class="stat-book-caption">
                            <span class="stat-book-title">
                              <Show when={loaded().titles.get(bookId)} fallback="Removed book">
                                {(title) => <A href={`/book/${bookId}`}>{title()}</A>}
                              </Show>
                            </span>
                            <span class="stat-book-time">{formatDuration(seconds)}</span>
                          </div>
                          <span class="stat-book-track" aria-hidden="true">
                            <span
                              style={{
                                width: `${Math.max(0, Math.min(100, (seconds / Math.max(1, loaded().stats.totalSeconds)) * 100))}%`,
                              }}
                            />
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
                <section class="stats-history">
                  <div class="stats-section-heading">
                    <h2>Recent reading days</h2>
                    <span>Last 30 recorded days</span>
                  </div>
                  <table class="reading-days-table">
                    <thead>
                      <tr>
                        <th scope="col">Day</th>
                        <th scope="col">Time read</th>
                        <th scope="col">Last position</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={[...loaded().stats.perDay.entries()].reverse().slice(0, 30)}>
                        {([day, seconds]) => (
                          <tr>
                            <th scope="row">{day}</th>
                            <td>{formatDuration(seconds)}</td>
                            <td>
                              <Show
                                when={loaded().stats.perDayProgress.get(day)?.size}
                                fallback="—"
                              >
                                <For each={[...(loaded().stats.perDayProgress.get(day) ?? [])]}>
                                  {([bookId, fraction]) => (
                                    <div>
                                      {loaded().titles.get(bookId) ?? 'Removed book'}:{' '}
                                      {Math.round(fraction * 100)}%
                                    </div>
                                  )}
                                </For>
                              </Show>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </section>
              </div>
            </Show>
            <details class="stats-method">
              <summary>
                About these numbers <Icon name="chevron-down" size={16} />
              </summary>
              <p>
                Derived from saved reading sessions, including synced devices when configured. Days
                and streaks use this device's timezone. Reading time estimates visible reader time.
              </p>
              <p>
                Positions show the last recorded location for each book that day. They can move
                backward when you reread or seek; they are not a measure of pages understood.
              </p>
            </details>
          </>
        )}
      </Show>
    </section>
  );
}

function sortedPerBook(stats: ReadingStats): Array<[string, number]> {
  return [...stats.perBook.entries()].sort((left, right) => right[1] - left[1]);
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
