/**
 * The Person Creator's icons: categories, their pages, and the choices that
 * read better as a picture than as a word (sex, age, build). Line icons on a
 * 24 grid, drawn in the interface's own stroke, as the rest of the game's.
 */
const P: Record<string, string> = {
  // ---- categories
  who: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',
  face: '<ellipse cx="12" cy="12" rx="7" ry="9"/><path d="M9 10h.01M15 10h.01"/><path d="M9.5 15.5c1.5 1.2 3.5 1.2 5 0"/>',
  body: '<circle cx="12" cy="4" r="2"/><path d="M12 7v7M7 9l5-1 5 1M9 22l3-8 3 8"/>',
  skin: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11Z"/>',
  hair: '<path d="M5 14c0-6 3-10 7-10s7 4 7 10"/><path d="M5 14c1 3 2 6 1 8M19 14c-1 3-2 6-1 8"/><path d="M8 8c2 2 6 2 8-1"/>',
  clothes: '<path d="m8 3-5 4 3 4 2-1v11h8V10l2 1 3-4-5-4c0 2-1.5 3-3 3S8 5 8 3Z"/>',
  saved: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14a5 5 0 0 1 6 4.5V20"/>',
  // ---- pages
  quick: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/><path d="M19 3l1 2 2 .5-2 1-1 2-1-2-2-1 2-.5Z" fill="currentColor" stroke="none"/>',
  presets: '<ellipse cx="12" cy="12" rx="7" ry="9"/><path d="M12 9v5l-1.5 1"/><path d="M9 8h1.5M13.5 8H15"/>',
  detail: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="1.8" fill="currentColor"/><circle cx="15" cy="12" r="1.8" fill="currentColor"/><circle cx="7" cy="18" r="1.8" fill="currentColor"/>',
  expression: '<circle cx="12" cy="12" r="9"/><path d="M8 14c2 3 6 3 8 0"/><path d="M8 9.5h.01M16 9.5h.01"/>',
  macro: '<circle cx="12" cy="4" r="2"/><path d="M12 7v7M7 9l5-1 5 1M9 22l3-8 3 8"/><path d="M20 4v16M18 6l2-2 2 2M18 18l2 2 2-2"/>',
  origin: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  shape: '<path d="M8 3c-1 4 0 6 1 9s0 6-1 9M16 3c1 4 0 6-1 9s0 6 1 9"/>',
  eyeColour: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  hairstyle: '<path d="M5 15c0-7 3-11 7-11s7 4 7 11"/><path d="M8 8c2 2 6 2 8-1"/>',
  colour: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.5" fill="currentColor"/><circle cx="12" cy="7" r="1.5" fill="currentColor"/><circle cx="16" cy="10" r="1.5" fill="currentColor"/><path d="M12 21a3 3 0 0 1 0-6h2"/>',
  makeup: '<path d="M9 21V11h6v10Z"/><path d="M10 11V6l4-3v8"/>',
  beard: '<path d="M5 8v4c0 5 3 9 7 9s7-4 7-9V8"/><path d="M9 14c2 1 4 1 6 0"/>',
  brows: '<path d="M3 11c2-3 5-3 7-2M14 9c2-1 5-1 7 2"/><path d="M6 15h.01M18 15h.01"/>',
  lashes: '<path d="M3 13c3 3 15 3 18 0"/><path d="M6 15l-1 2M10 16v2.5M14 16v2.5M18 15l1 2"/>',
  outfit: '<path d="m8 3-5 4 3 4 2-1v11h8V10l2 1 3-4-5-4c0 2-1.5 3-3 3S8 5 8 3Z"/>',
  top: '<path d="M7 4 3 8l2 3 2-1v10h10V10l2 1 2-3-4-4h-3a2 2 0 0 1-4 0Z"/>',
  bottom: '<path d="M6 3h12l1 18h-5l-2-11-2 11H5Z"/>',
  dress: '<path d="M9 3h6l-1 5 5 13H5l5-13Z"/>',
  suit: '<path d="M7 3 3 7v14h18V7l-4-4"/><path d="m7 3 5 8 5-8M12 11v10"/>',
  dye: '<path d="M7 3h10v4l-3 3v11h-4V10L7 7Z"/>',
  footwear: '<path d="M3 17V9h5l1 3 7 2c3 .8 5 2 5 3v1H3Z"/><path d="M3 20h18"/>',
  hat: '<path d="M3 17h18"/><path d="M6 17c0-6 2-10 6-10s6 4 6 10"/>',
  glasses: '<circle cx="7" cy="14" r="3.5"/><circle cx="17" cy="14" r="3.5"/><path d="M10.5 14h3M3.5 13 2 9M20.5 13 22 9"/>',
  jewelry: '<circle cx="12" cy="15" r="5"/><path d="m9 6 3-3 3 3-3 4Z"/>',
  gloves: '<path d="M7 21v-8l-2-4 1-1 3 3V4h2v6V3h2v7V4h2v7l2-3h1v6l-3 7Z"/>',
  socks: '<path d="M8 3h6v10l4 3a2.5 2.5 0 0 1-2 5l-8-4Z"/>',
  underwear: '<path d="M3 7h18l-2 7-5 1-2 3-2-3-5-1Z"/>',
  mask: '<path d="M3 9c3-2 15-2 18 0v3c0 4-4 7-9 7s-9-3-9-7Z"/><path d="M7 12h3M14 12h3"/>',
  horns: '<path d="M7 14c-3-1-5-5-4-10 2 3 4 5 6 6M17 14c3-1 5-5 4-10-2 3-4 5-6 6"/><circle cx="12" cy="16" r="5"/>',
  equipment: '<rect x="5" y="7" width="14" height="13" rx="2"/><path d="M9 7V4h6v3M5 12h14"/>',
  // ---- rows of the quick page
  sex: '<circle cx="9" cy="10" r="5"/><path d="M9 15v6M6 18h6"/><path d="M14 6l6-6M16 0h4v4" transform="translate(0 2)"/>',
  age: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  build: '<path d="M12 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/><path d="M7 21l1-9-3-2M17 21l-1-9 3-2M8 12h8"/>',
  faces: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
  tone: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
  // face parts
  part_shape: '<ellipse cx="12" cy="12" rx="7" ry="9"/>',
  part_nose: '<path d="M12 4c0 5-3 9-3 12 0 2 2 2 3 2s3 0 3-2"/>',
  part_eyes: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  part_mouth: '<path d="M4 12c3-3 5-3 8-2 3-1 5-1 8 2-3 4-13 4-16 0Z"/><path d="M4 12h16"/>',
  part_jaw: '<path d="M5 6v6c0 5 3 9 7 9s7-4 7-9V6"/>',
  part_cheeks: '<ellipse cx="12" cy="12" rx="7" ry="9"/><circle cx="8" cy="14" r="1.6"/><circle cx="16" cy="14" r="1.6"/>',
  // ---- choices
  female: '<circle cx="12" cy="9" r="5"/><path d="M12 14v8M9 19h6"/>',
  male: '<circle cx="10" cy="14" r="5"/><path d="M14 10l6-6M15 4h5v5"/>',
  child: '<circle cx="12" cy="10" r="2"/><path d="M12 12.5v4M9.5 14h5M10.5 21l1.5-4.5 1.5 4.5"/>',
  young: '<circle cx="12" cy="5" r="2"/><path d="M12 7.5v7M8.5 10h7M10 22l2-7.5 2 7.5"/>',
  adult: '<circle cx="12" cy="4" r="2"/><path d="M12 6.5v8M8 9.5h8M9.5 22l2.5-7.5 2.5 7.5"/>',
  old: '<circle cx="11" cy="4" r="2"/><path d="M11 6.5 10 14M7 10l3-1 3 2M8 22l2-8 2 8M16 12v10M16 12c0-1 2-1 2 0"/>',
  slim: '<circle cx="12" cy="4" r="2"/><path d="M11 7h2v8h-2zM11 15l-1 7M13 15l1 7"/>',
  average: '<circle cx="12" cy="4" r="2"/><path d="M10 7h4v8h-4zM10.5 15l-1 7M13.5 15l1 7"/>',
  athletic: '<circle cx="12" cy="4" r="2"/><path d="M7 7h10l-2 8H9ZM10 15l-1 7M14 15l1 7"/>',
  heavy: '<circle cx="12" cy="4" r="2"/><path d="M8 7h8c1.5 3 1.5 6 0 8H8c-1.5-2-1.5-5 0-8ZM9.5 15l-1 7M14.5 15l1 7"/>',
  none: '<circle cx="12" cy="12" r="8"/><path d="m6.5 17.5 11-11"/>',
  own: '<path d="m8 3-5 4 3 4 2-1v11h8V10l2 1 3-4-5-4c0 2-1.5 3-3 3S8 5 8 3Z"/><path d="m9 15 2 2 4-4"/>',
  // ---- actions
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>',
  save: '<path d="M5 3h11l3 3v15H5Z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="m9 22 3-8 3 3v5M8 12l2-4 4 1 2 4"/>',
  stand: '<circle cx="12" cy="4" r="2"/><path d="M12 7v7M8 10h8M10 22l2-8 2 8"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
};

export function creatorIcon(name: string, size = 20): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? P['who']}</svg>`;
}
