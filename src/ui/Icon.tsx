import { For } from 'solid-js';

const paths = {
  'arrow-left': ['M19 12H5', 'm12 19-7-7 7-7'],
  'arrow-right': ['M5 12h14', 'm12 5 7 7-7 7'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-right': ['m9 5 7 7-7 7'],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M21 21l-4.4-4.4', 'M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0'],
  sliders: ['M4 7h9m4 0h3M4 17h3m4 0h9', 'M13 4v6M7 14v6'],
  book: ['M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Z', 'M12 5v15'],
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  chart: ['M4 19V9M12 19V4M20 19v-6'],
  settings: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    'm9 3 1-1h4l1 3 3 1 3 2v4l-2 2-1 3-3 1-1 3h-4l-1-3-3-1-2-3V9l3-1 1-3Z',
  ],
  close: ['m6 6 12 12M6 18 18 6'],
  more: ['M5 12h.01M12 12h.01M19 12h.01'],
  check: ['m5 12 4 4L19 6'],
  sun: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  ],
  moon: ['M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z'],
  download: ['M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'],
  edit: ['m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z'],
  bookmark: ['M6 3h12v18l-6-4-6 4Z'],
  sidebar: ['M3 3h18v18H3Z', 'M9 3v18'],
  type: ['M4 5h16M12 5v15M8 20h8'],
  focus: ['M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5', 'M9 9h6v6H9z'],
  'page-single': ['M6 3h12v18H6z'],
  'page-double': ['M2 4h9v16H2zM13 4h9v16h-9z'],
  'page-scroll': ['M5 2h14v8H5zM5 14h14v8H5z'],
  rotate: ['M3 10a9 9 0 1 1 2 9', 'M3 3v7h7'],
  maximize: ['M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5'],
} as const;

/** Decorative glyphs: the owning control supplies its accessible name. */
export default function Icon(props: { name: keyof typeof paths; size?: number; class?: string }) {
  return (
    <svg
      class={props.class}
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <For each={paths[props.name]}>{(d) => <path d={d} />}</For>
    </svg>
  );
}
