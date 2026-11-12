# Using Book Reader

The app keeps your library on the current device. You can read downloaded books without an account
or network connection. Optional private sync copies your library between installations; an external
backup protects you if browser storage is cleared or a device is lost.

The experimental desktop build is local-only. Move a library with a portable backup; native
sign-in and synchronization are not yet available. See [Desktop](DESKTOP.md) for its current limits.

## Import and organize

1. Open **Library**, choose **Add books**, and select one or more DRM-free files in the file picker.
   The button also works with the keyboard. Cancelling the picker leaves your library unchanged.
2. Review the import result. EPUB and PDF can be read; other recognized formats can be stored and
   tracked but do not yet have a reading adapter. Some layouts remain unsupported.
3. Open a book's details to edit missing metadata, choose shelves/tags, or change its reading status.
4. Use the **All books**, **Reading**, **To read** and **Finished** controls for everyday browsing.
   Search by title or author, choose **Sort by**, or open **Filters** for format, shelf, tag and
   archived-book options. Active filters are indicated on the Filters control.

Rename shelves or tags under **Settings → Collections**. The new name applies to every book using
that collection; memberships stay intact. Tag names ignore case and extra whitespace for duplicate
detection, so choose a name not already used by another tag on this device. Concurrent offline
edits on different devices can still produce matching names; rename one to distinguish them.

Identical original bytes identify the same book. Re-importing the same file repairs a missing or
corrupt local original without replacing your edited metadata. A different edition/file has a
different identity even if the title is identical. Keep the original files until you have verified
another copy or a portable backup.

Open **Manage book** on a book's details page to archive it or mark it as deleted. **Archive** hides
a book from the normal view and is reversible through **Filters → Show → Archived**. Deleting
metadata is a separate confirmed action that retains a tombstone; it does not secretly remove the
remote original. Cache cleanup also has separate rules.

## Make it your own

Settings groups everyday preferences ahead of maintenance tools. Use its section links to jump to
**Appearance & privacy**, **Collections**, **Backups & sync**, **Storage** or **Advanced**. On a
small screen the same links wrap above the settings content.

Choose **Theme** to follow the device, stay light or stay dark. Choose an accent preset or a custom
colour; appearance changes apply immediately and remain on this device. Under **Privacy**, online
dictionary access is optional and can be switched off at any time.

Dropdowns work with a mouse, touch or keyboard. Use the arrow keys or type a label to preview a
choice, then press Enter or Space to apply it. Escape, Tab or clicking elsewhere leaves the saved
choice unchanged. In reader settings, Escape closes the dropdown first, then the settings sheet.
The app follows your device's reduced-motion preference for transitions and menu animations.

Collection rename and delete actions stay visible next to each shelf or tag. Renaming opens a
labelled form; **Save name** applies the change and **Cancel rename** returns to the collection.
Deleting a collection asks for confirmation and keeps its books in the library.

**Advanced diagnostics**, **Backup options & limits** and **Manage local storage** are expandable
sections. Open only the tools you need; collapsing them does not change a preference or remove data.

## Read, search and annotate

Choose **Read** from a local book's details. Use the reader's navigation controls or arrow keys;
arrow keys in text inputs remain available for editing. Open the sidebar for contents, PDF pages,
search, notes, reader settings or read-aloud where supported. Sidebar tabs also support keyboard
navigation and can be resized with the keyboard.

Open **Reader settings** in the top-right corner to choose **Single**, **Facing** or **Continuous**.
Facing mode displays two pages when the reading area is wide enough; narrower windows use one.
PDF facing mode can keep the cover separate and reverse the visual page order for right-to-left
publications. Previous/Next move one spread in facing mode.

PDF controls include **Fit width**, **Fit page**, **Actual size**, 50–400% zoom, clockwise rotation,
margins and optional page-colour inversion. Inversion also changes images; turn it off when original
colours matter. Continuous PDF mode lets you scroll through the document while nearby pages load.
A page that fails to render displays an error; other pages and your last usable position remain available.

For reflowable EPUBs, choose publisher, serif, sans serif or monospace type; adjust text size, line
height, alignment, column width, letter spacing and paragraph spacing. **Paper**, **Sepia** and
**Night** control the reading background independently of the app theme. Continuous EPUB mode scrolls
within a section; a further mouse-wheel gesture at its boundary continues to the next/previous section.
The Next/Previous controls also work, including on touch devices. Fixed-layout EPUBs retain the
publisher's geometry and spread rules, so text reflow and continuous mode are unavailable.

Use the page/section number in the footer to jump directly. **Focus mode** (F) hides the controls and
sidebar; **Exit focus** or Escape restores them. **Full screen** expands the reader where the browser
supports it. These shortcuts also work when focus is inside an EPUB. S or [ toggles the sidebar.
Typing in controls keeps normal editing behavior.

Preferences save on this device and survive reopening. Layout changes preserve the current logical
page/section; reflow can shift the exact visible line and a page that fully fits cannot retain a
vertical scroll offset. **Reset reading settings** restores the reader defaults without removing
progress, notes or highlights.

Progress saves automatically. Reopen the book to return to the saved position. A visible save error
means the position has not been confirmed in the database: use **Retry saving position**. A recent
local journal can recover pending intent on reopen, but clearing browser data or failure of all
available storage can still lose an unsaved position.

Select text to highlight or look up a single English word. Notes and bookmarks appear in the notes
panel and on the book's details page. You can export book notes as Markdown. Text selection and
search depend on the original: image-only PDFs need a text layer before those features can work.

If the Notes panel reports **Anchor unavailable**, the renderer could not place that annotation
in this original. Your note stays editable and exportable. Text anchors in pages or chapters you
have not loaded yet are unchecked, so absence of a warning does not certify every annotation.

Online definitions require opt-in and send the selected word to dictionaryapi.dev. Turn the option
off in Settings at any time. Read-aloud uses browser/platform voices; their availability and network
requirements vary. Reading, notes and highlights do not require dictionary access.

If another device has substantially different progress, the reader offers both positions. Choose
the one you want rather than relying on the furthest percentage: rereading can legitimately move
backward.

## Keep books offline

Open a downloaded book's details and pin it to keep it out of application cache cleanup. You can
also save its original file separately. Pins belong to this device; a new installation needs its
own downloads and pins.

**Settings → Storage** shows original-file storage and pinned books. Open **Manage local storage**
to enter a target size and choose **Free local space**. Cleanup only removes eligible unpinned
originals after confirming a matching verified copy on your configured server. Open books,
tombstoned originals, metadata, annotations and covers are kept. If the target cannot be reached
safely, the app reports that and leaves protected copies alone.

A pin cannot prevent the browser or operating system from clearing site data. In a production web
build, complete one online load and wait for **App ready offline** before relying on offline reload.
Development preview without a production build does not install that cache. Updates wait for
existing app windows to close; save/close your reading before reopening for a waiting update.

## Sync across devices

A server must be configured in the application build; a default local installation has none.
Deployment is an owner/setup task described in [server setup](../server/README.md). There is no
account password or secret to paste into the app settings.

With private sync configured, use the same authorized account on each installation. Local metadata
changes sync while the app is open; original uploads follow metadata sync. On another installation,
request an original download before reading it. Downloads verify the file before marking it local.

**Settings → Backups & sync** shows status, the last successful **metadata** sync and pending file
transfers. Queue counts and cursor details are under **Advanced diagnostics → Sync readiness**.
The metadata timestamp does not mean every original upload finished. Pause/resume or **Sync now**
as needed. Auth expiry requires signing in again. Failed work stays inspectable; do not clear
browser data or delete queues merely to remove a warning.

## Back up and recover

In **Settings → Backups & sync**, **Download portable backup** saves metadata, originals and
available covers in one archive. Download every original first. The current archive limit is
128 MiB total and 64 MiB per original; keep JSON plus separately saved originals for a larger
library. Limits and the alternative format are explained in **Backup options & limits**.

Open **Backup options & limits → Export library as JSON** for metadata and annotations without
book bytes. Browser builds download the file; desktop builds open a native Save dialog. Store
backups outside browser/site data. Rehearse recovery in a fresh profile before treating a backup
as dependable. The footer's **Back up your library** link jumps directly to this section.

To recover, choose **Restore from backup…**, select the portable archive or JSON, and read the
validated preview. Applying recovery adds missing data and keeps existing records. It does not
reset this installation's identity or replay old transfer queues. A JSON-only restore requires
originals to be downloaded or re-imported before reading. See [Backup](BACKUP.md) for merge details.

## Statistics and troubleshooting

Stats summarizes saved reading activity, including synced sessions when configured. Reading days
and streaks use this device's timezone. Time estimates visible reader activity; it does not measure
attention. Daily positions show the last recorded location for each book and can decrease after
rereading or seeking.

- **Missing book file:** download it from your configured server or re-import identical bytes.
- **Memory-only storage notice:** save originals/backup before closing; these bytes will not survive.
- **Page cannot render:** preserve the original and navigate to a different page. Some source images
  exceed the renderer's resource limits; a retained previous page is not the failed page.
- **Save error:** retry while the app is open and check available device/browser storage.
- **Stuck sync:** inspect the status, reauthenticate or retry as directed; keep queued local changes.
- **Need support:** open **Settings → Advanced diagnostics → Download diagnostics**. The report contains aggregate state and versions,
  with no book content, filenames, account/device IDs, server URLs or raw errors. Do not share a
  whole library export when a diagnostics report will answer the problem.

Technical setup and recovery exercises are in [Runbook](RUNBOOK.md). Platform and size limitations
are listed in [README](../README.md) and the [Roadmap](ROADMAP.md).
