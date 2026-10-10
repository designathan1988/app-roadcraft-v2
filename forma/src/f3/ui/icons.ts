// Ícones de traço do FORMA 3 (os do FORMA mais os novos).
import { ICON_PATHS } from '../../ui/icons';

const EXTRA: Record<string, string> = {
  push: 'M4 14h16v6H4z M12 12V3 M8 7l4-4 4 4',
  pencil: 'M4 20l4-1 11-11-3-3L5 16z M14 6l3 3',
  arc: 'M4 18a10 10 0 0116 0 M4 18h.01 M20 18h.01 M12 8v.01',
  tape: 'M3 15l12-12 6 6-12 12z M7 11l2 2 M10 8l2 2 M13 5l2 2',
  paint: 'M4 13l7-7 7 7-7 7z M18 13c1 2 3 3 3 5a2 2 0 01-4 0c0-2 1-3 1-5z M11 6V3',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z',
  subtract: 'M3 3h12v12H3z M9 9h12v12H9z M9 9h6v6H9z',
  intersect: 'M3 3h12v12H3z M9 9h12v12H9z',
  add: 'M12 5v14 M5 12h14',
  catalog: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M17 14v7 M14 17h7',
  path: 'M3 19c4 0 4-8 9-8s5-6 9-6',
  enter: 'M10 3H4v18h6 M14 8l4 4-4 4 M18 12H8',
  exit: 'M14 3h6v18h-6 M10 8l-4 4 4 4 M6 12h10',
  array: 'M3 9h4v6H3z M10 9h4v6h-4z M17 9h4v6h-4z',
  unique: 'M12 3l9 5v8l-9 5-9-5V8z M12 8v8 M8 10l4-2 4 2',
  lean: 'M6 21L9 3h9l-3 18z',
  taper: 'M4 21L8 3h8l4 18z',
  round: 'M4 20V10a6 6 0 016-6h10',
  chamfer: 'M4 20V9l5-5h11',
  grid: 'M3 3h18v18H3z M3 9h18 M3 15h18 M9 3v18 M15 3v18',
  magnet: 'M6 3v8a6 6 0 0012 0V3 M6 7h4 M14 7h4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 100 6 3 3 0 000-6',
  terrace: 'M3 12h18v9H3z M3 12V9h18v3 M6 9V6 M18 9V6',
  vault: 'M3 21V12a9 9 0 0118 0v9z',
  pyramid: 'M12 3l9 18H3z M12 3v18',
  sawtooth: 'M3 21V12l5-6v6l5-6v6l5-6v15z',
  gambrel: 'M3 21v-7l3-6 6-4 6 4 3 6v7z',
};

export const icon = (name: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EXTRA[name] ?? ICON_PATHS[name] ?? ICON_PATHS.cube}"/></svg>`;
