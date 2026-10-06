/** The creator's icons: 24x24 strokes, drawn in the current text colour. */

const PATHS: Readonly<Record<string, string>> = {
  person: '<circle cx="12" cy="7" r="3.2"/><path d="M5.5 20c.6-4 3.2-6 6.5-6s5.9 2 6.5 6"/>',
  body: '<circle cx="12" cy="4.2" r="2"/><path d="M8 8h8l-1 6h-1.5l-.5 7h-2l-.5-7H9z"/><path d="M8 8 5.5 13M16 8l2.5 5"/>',
  head: '<path d="M12 3c4 0 6.5 3 6.5 7 0 3-1.5 5-3 6.5L14 21h-4l-1.5-4.5C7 15 5.5 13 5.5 10c0-4 2.5-7 6.5-7z"/>',
  eye: '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.8"/>',
  nose: '<path d="M11 4c0 5-3.5 8-3.5 11a2.5 2.5 0 0 0 2.5 2.5h.5M13 17.5h.5a2.5 2.5 0 0 0 2.5-2.5c0-1-.5-2-1.2-3"/>',
  mouth: '<path d="M3.5 12c2.5-2.5 5-3 6.5-2 1 .7 1.5.7 2 0 1.5-1 4.5-.5 8.5 2-3 3.5-6 5-8.5 5S6.5 15.5 3.5 12z"/><path d="M3.5 12h17"/>',
  ear: '<path d="M8 9a5 5 0 0 1 10 0c0 3-2.5 4-3.5 6.5S12 20 10 20s-3-1.5-3-3"/><path d="M11 9.5a2 2 0 0 1 4 0c0 1.5-1.5 2-2 3"/>',
  jaw: '<path d="M4 6c0 7 3 12 8 14 5-2 8-7 8-14"/><path d="M8.5 15.5c1.2 1 2.3 1.5 3.5 1.5s2.3-.5 3.5-1.5"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.4-1.4-1.6-1.4-3 0-1 .8-1.8 1.9-1.8H17a4 4 0 0 0 4-4C21 6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14.5c1 1.4 2.4 2 4 2s3-.6 4-2"/><path d="M9 9.5h.01M15 9.5h.01"/>',
  hair: '<path d="M5 15c-1-6 2.5-11 7-11s8 5 7 11"/><path d="M5 15c1 3 2 5 3 6M19 15c-1 3-2 5-3 6"/><path d="M8 8c2 2 6 2 8-1"/>',
  brow: '<path d="M3 13c3-4 7-5 11-4 3 .6 5 2 7 3"/><path d="M6 17h.01M10 16.5h.01M14 16.5h.01"/>',
  lips: '<path d="M3 12c3-3 5-4 7-3l2 1 2-1c2-1 4 0 7 3-3 4-6 5-9 5s-6-1-9-5z"/><path d="M3 12h18"/>',
  shirt: '<path d="M8 4 4 7l2 4 2-1v10h8V10l2 1 2-4-4-3c-.5 1.5-2 2.5-4 2.5S8.5 5.5 8 4z"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h.01M15 15h.01M15 9h.01M9 15h.01M12 12h.01"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  gallery: '<rect x="3.5" y="4" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="4" width="7.5" height="7.5" rx="1.5"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4h4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
};

export function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;
}
