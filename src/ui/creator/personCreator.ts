import { ageFromYears, yearsFromAge, type MacroParams } from '@people/body/macro';
import {
  ALL_BROWS, ALL_LASHES,
  CLOTH_COLOURS, EYE_COLOURS, HAIR_COLOURS, SKIN_TONES, WARDROBE, outfitsForAge, defaultPerson, randomPerson,
  type BottomStyle, type HairStyle, type PersonLook, type PersonSpec, type TopStyle,
} from '@people/spec';
import { hasKey, t } from '../i18n';
import { hairFor, itemLabel, itemsOf, shoesFor } from '@people/wardrobe';
import { FACE_PARTS, applyFacePreset } from '@people/facePresets';
import { skinColour } from '@people/phenotype';
import { proxyUrl } from '@people/body/proxy';
import { creatorIcon } from './creatorIcons';
import './personCreator.css';

/**
 * The Person Creator: build anybody - any sex, age, body, skin, face, hair and
 * clothes - see them in 3D as the sliders move, and save them with the city.
 *
 * It lives in the side panel like every other tool. The MakeHuman packs are
 * fetched the first time it opens, never at boot. The preview has its own
 * small renderer, drawn only when something changed or the person is being
 * turned.
 */

/** The 3D preview, made by the renderer (`render/people/personPreview.ts`) and handed in. */
export interface PersonPreviewPort {
  setActive(active: boolean): void;
  readonly ready: Promise<void>;
  show(person: PersonSpec): void;
  setLook(look: PersonLook): void;
  setWalking(walking: boolean): void;
  turn(delta: number): void;
  zoom(delta: number): void;
  readonly height: number;
}

export interface PersonCreatorHost {
  /** Makes the preview on the creator's own canvas. */
  preview(canvas: HTMLCanvasElement): PersonPreviewPort;
  people(): readonly PersonSpec[];
  save(person: PersonSpec): void;
  remove(id: number): void;
  nextId(): number;
}

export interface PersonCreator {
  /** The controls: mounted in the side panel. */
  readonly root: HTMLElement;
  /**
   * The 3D preview: mounted outside the panel, beside it (above the sheet on
   * a phone), so it stays in view however far down the controls are scrolled.
   */
  readonly stage: HTMLElement;
  activate(): void;
  deactivate(): void;
  /** The saved list changed elsewhere (undo, a loaded map). */
  refresh(): void;
  relabel(): void;
}

/** Face and body detail sliders offered, by MakeHuman regional slider name. */
const FACE_SLIDERS = [
  'head-fat-decr-incr', 'head-scale-vert-decr-incr', 'nose-scale-horiz-decr-incr', 'nose-scale-vert-decr-incr',
  'nose-curve-concave-convex', 'mouth-scale-horiz-decr-incr', 'mouth-lowerlip-volume-decr-incr', 'eye-scale-decr-incr',
  'ear-scale-decr-incr', 'chin-width-decr-incr', 'chin-prominent-decr-incr', 'cheek-bones-decr-incr',
] as const;
/** The face's expression: MakeHuman's mouth and brow targets, held. */
const EXPRESSION_SLIDERS = [
  'mouth-angles-down-up', 'mouth-laugh-lines-in-out', 'mouth-dimples-in-out', 'eyebrows-angle-down-up', 'eyebrows-trans-down-up',
] as const;
const BODY_SLIDERS = [
  'measure-shoulder-dist-decr-incr', 'measure-waist-circ-decr-incr', 'measure-hips-circ-decr-incr',
  'stomach-pregnant-decr-incr', 'torso-vshape-decr-incr', 'upperarm-muscle-decr-incr',
  'upperlegs-height-decr-incr', 'measure-neck-height-decr-incr',
] as const;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

export function createPersonCreator(host: PersonCreatorHost): PersonCreator {

  const root = el('div', 'person-creator');
  let person: PersonSpec = defaultPerson(host.nextId());
  let loaded = false;

  // ------------------------------------------------------------ preview
  const stage = el('div', 'pc-stage');
  const canvas = el('canvas', 'pc-canvas');
  const status = el('div', 'pc-status');
  const heightTag = el('div', 'pc-height');
  // Walk on the spot: the person as the street will see them move.
  const walkButton = el('button', 'pc-walk');
  walkButton.type = 'button';
  walkButton.setAttribute('aria-pressed', 'false');
  let walking = false;
  walkButton.addEventListener('click', () => {
    walking = !walking;
    walkButton.setAttribute('aria-pressed', String(walking));
    walkButton.classList.toggle('active', walking);
    walkButton.innerHTML = creatorIcon(walking ? 'stand' : 'walk', 18);
    walkButton.title = t(walking ? 'person.stand' : 'person.walk');
    preview.setWalking(walking);
  });
  stage.append(canvas, status, heightTag, walkButton);
  const preview = host.preview(canvas);
  void preview.ready.then(() => {
    loaded = true;
    status.textContent = '';
    reshape();
  }, () => {
    status.textContent = t('person.loadFailed');
  });

  let dragging: { id: number; x: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = { id: e.pointerId, x: e.clientX };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || dragging.id !== e.pointerId) return;
    preview.turn(-(e.clientX - dragging.x) * 0.012);
    dragging.x = e.clientX;
  });
  const endDrag = (): void => {
    dragging = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    preview.zoom(-Math.sign(e.deltaY));
  }, { passive: false });

  // ------------------------------------------------------------ morphing
  let shapeQueued = false;
  const reshape = (): void => {
    shapeQueued = false;
    preview.show(person);
    if (!loaded) return;
    heightTag.textContent = `${preview.height.toFixed(2)} m · ${Math.round(yearsFromAge(person.body.age))} ${t('person.years')}`;
  };
  const queueShape = (): void => {
    if (shapeQueued) return;
    shapeQueued = true;
    requestAnimationFrame(reshape);
  };

  const setBody = (patch: Partial<MacroParams>): void => {
    const wasChild = yearsFromAge(person.body.age) < 16;
    person = { ...person, body: { ...person.body, ...patch } };
    if (patch.age !== undefined) {
      if (yearsFromAge(person.body.age) < 16 && person.look.outfit) {
        const { outfit: _outfit, footwear: _footwear, ...childLook } = person.look;
        void _outfit; void _footwear;
        person = { ...person, look: { ...childLook, top: 'tshirt', bottom: 'shorts', hat: 'none' } };
        preview.setLook(person.look);
      }
      if (wasChild !== (yearsFromAge(person.body.age) < 16)) renderControls();
    }
    queueShape();
  };
  const setFeature = (name: string, value: number): void => {
    const features = { ...person.features };
    if (value === 0) delete features[name];
    else features[name] = value;
    person = { ...person, features };
    queueShape();
  };
  const setLook = (patch: Partial<PersonLook>): void => {
    person = { ...person, look: { ...person.look, ...patch } };
    preview.setLook(person.look);
    renderControls();
  };

  const setPigment = (patch: { melanin?: number; undertone?: number }): void => {
    const melanin = patch.melanin ?? person.look.melanin ?? 0.5;
    const undertone = patch.undertone ?? person.look.undertone ?? 0.5;
    person = { ...person, look: { ...person.look, melanin, undertone, skin: skinColour(melanin, undertone) } };
    preview.setLook(person.look);
  };

  // ------------------------------------------------------------ controls
  // Laid out as a life-simulation game's create-a-person lays it out: a rail
  // of categories (who, face, body, skin, hair, clothes, saved), the
  // category's pages as icons, and one page at a time - a grid of pictures,
  // a row of choices, or the fine sliders. Every name is a tooltip.
  const actions = el('div', 'pc-actions');
  const nameInput = el('input', 'pc-name');
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.addEventListener('input', () => {
    person = { ...person, name: nameInput.value };
  });
  const iconButton = (className: string, icon: string): HTMLButtonElement => {
    const b = el('button', className);
    b.type = 'button';
    b.innerHTML = creatorIcon(icon, 18);
    return b;
  };
  const randomButton = iconButton('pc-icon', 'dice');
  randomButton.addEventListener('click', () => {
    person = { ...randomPerson(person.id, (Math.random() * 2 ** 31) >>> 0), name: person.name };
    preview.setLook(person.look);
    queueShape();
    renderControls();
  });
  const saveButton = iconButton('pc-icon primary', 'save');
  saveButton.addEventListener('click', () => {
    host.save({ ...person, name: nameInput.value.trim() });
    renderSaved();
    flashSaved();
  });
  const newButton = iconButton('pc-icon', 'plus');
  newButton.addEventListener('click', () => {
    person = defaultPerson(host.nextId());
    nameInput.value = '';
    preview.setLook(person.look);
    queueShape();
    renderControls();
    renderSaved();
  });
  actions.append(nameInput, randomButton, newButton, saveButton);

  const rail = el('nav', 'pc-rail');
  const pages = el('div', 'pc-pages');
  const controls = el('div', 'pc-controls');
  const saved = el('div', 'pc-saved');
  const main = el('div', 'pc-main');
  main.append(pages, controls);
  const body = el('div', 'pc-body');
  body.append(rail, main);

  interface Page { readonly key: string; readonly label: string; readonly icon: string; build(into: HTMLElement): void }
  interface Category { readonly key: string; readonly label: string; readonly icon: string; readonly pages: readonly Page[] }
  let category = 'who';
  const pageOf = new Map<string, string>();

  const slider = (into: HTMLElement, label: string, value: number, min: number, max: number, step: number,
    onInput: (v: number) => void, format: (v: number) => string, icon?: string): void => {
    const row = el('label', 'pc-slider' + (icon ? ' iconic' : ''));
    const name = el('span', 'pc-slider-name', label);
    if (icon) {
      name.innerHTML = creatorIcon(icon, 18);
      row.title = label;
    }
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', label);
    const out = el('span', 'pc-slider-value', format(value));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = format(v);
      onInput(v);
    });
    row.append(name, input, out);
    into.appendChild(row);
  };
  /** A row: its icon (the name in the tooltip), then what it holds. */
  const row = (into: HTMLElement, label: string, icon: string): HTMLElement => {
    const r = el('div', 'pc-row');
    const head = el('span', 'pc-row-icon');
    head.innerHTML = creatorIcon(icon, 18);
    head.title = label;
    const list = el('div', 'pc-row-items');
    r.append(head, list);
    into.appendChild(r);
    return list;
  };
  /** One choice: an icon, or a short mark (a number); its name in the tooltip. */
  const choice = (into: HTMLElement, label: string, on: boolean, pick: () => void, icon?: string, mark?: string): void => {
    const b = el('button', 'pc-opt' + (on ? ' active' : ''));
    b.type = 'button';
    if (icon) b.innerHTML = creatorIcon(icon, 18);
    else b.textContent = mark ?? '';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', pick);
    into.appendChild(b);
  };
  const swatches = (into: HTMLElement, label: string, icon: string, colours: readonly number[], current: number, onPick: (c: number) => void): void => {
    const list = row(into, label, icon);
    list.classList.add('pc-swatches');
    for (const c of colours) {
      const b = el('button', 'pc-swatch' + (c === current ? ' active' : ''));
      b.type = 'button';
      b.style.background = hex(c);
      b.title = hex(c);
      b.setAttribute('aria-label', `${label} ${hex(c)}`);
      b.setAttribute('aria-pressed', String(c === current));
      b.addEventListener('click', () => onPick(c));
      list.appendChild(b);
    }
    const custom = el('input', 'pc-swatch custom');
    custom.type = 'color';
    custom.value = hex(current < 0 ? 0x888888 : current);
    custom.title = t('person.custom');
    custom.setAttribute('aria-label', `${label} ${t('person.custom')}`);
    custom.addEventListener('input', () => onPick(parseInt(custom.value.slice(1), 16)));
    list.appendChild(custom);
  };
  /**
   * A gallery of MakeHuman items: a picture each (the pack's thumbnail), the
   * name in the tooltip; 'none' as a crossed tile when the item can be left off.
   */
  const gallery = (into: HTMLElement, names: readonly string[], current: string | undefined,
    onPick: (name: string) => void, withNone = false): void => {
    const list = el('div', 'pc-gallery');
    for (const name of withNone ? ['none', ...names] : names) {
      const on = name === (current ?? (withNone ? 'none' : ''));
      const b = el('button', 'pc-item' + (on ? ' active' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      const tile = el('span', 'pc-item-tile');
      if (name === 'none') {
        tile.innerHTML = creatorIcon('none', 22);
      } else {
        let url: string | null;
        try { url = proxyUrl(`${name}-thumb.webp`); } catch { try { url = proxyUrl(`${name}.webp`); } catch { url = null; } }
        if (url) tile.style.backgroundImage = `url("${url}")`;
      }
      b.appendChild(tile);
      const label = name === 'none' ? t('person.option.none') : hasKey(`person.item.${name}`) ? t(`person.item.${name}`) : itemLabel(name);
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', () => onPick(name));
      list.appendChild(b);
    }
    into.appendChild(list);
  };
  /** Wearing MakeHuman garments: picking any of them dresses a person saved before in all of them. */
  const wear = (patch: Partial<PersonLook>): void => {
    const female = person.body.gender < 0.5;
    setLook({
      outfit: person.look.outfit ?? (female ? WARDROBE.outfits.female[0] : WARDROBE.outfits.male[0]),
      footwear: person.look.footwear ?? WARDROBE.footwear[0],
      hairCut: person.look.hairCut ?? (person.look.hairStyle === 'none' ? 'none' : person.look.hairStyle === 'long' ? WARDROBE.hair.long[0] : WARDROBE.hair.short[0]),
      brows: person.look.brows ?? WARDROBE.brows[0],
      lashes: person.look.lashes ?? WARDROBE.lashes[0],
      hat: person.look.hat ?? 'none',
      outfitTint: person.look.outfitTint ?? null,
      ...patch,
    });
  };
  /** Takes on another person whole (a quick choice), keeping this one's id and name. */
  const become = (next: PersonSpec): void => {
    person = { ...next, id: person.id, name: person.name };
    preview.setLook(person.look);
    queueShape();
    renderControls();
  };
  /** Wears `name` in place of whatever of `family` was worn ('none' takes it off). */
  const wearExtra = (family: readonly string[], name: string): void => {
    const kept = (person.look.extras ?? []).filter((n) => !family.includes(n));
    wear({ extras: name === 'none' ? kept : [...kept, name] });
  };
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const signed = (v: number): string => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}`);

  /** Everything the creator offers, as categories of pages, for the person as they are now. */
  const categories = (): Category[] => {
    const b = person.body;
    const female = b.gender < 0.5;
    const sex = female ? 'female' as const : 'male' as const;
    const years = yearsFromAge(b.age);
    const adult = years >= 16;
    const dressed = !!person.look.outfit;
    const seed = (): number => (Math.random() * 2 ** 31) >>> 0;
    const page = (key: string, label: string, icon: string, build: (into: HTMLElement) => void): Page => ({ key, label, icon, build });

    const who: Page[] = [page('quick', t('person.section.quick'), 'quick', (into) => {
      const s = row(into, t('person.sex'), 'sex');
      choice(s, t('person.quick.woman'), female, () => become(randomPerson(person.id, seed(), { body: { gender: 0.04, age: b.age } })), 'female');
      choice(s, t('person.quick.man'), !female, () => become(randomPerson(person.id, seed(), { body: { gender: 0.96, age: b.age } })), 'male');
      const a = row(into, t('person.age'), 'age');
      for (const [key, y, on, icon] of [['person.quick.child', 8, years < 16, 'child'], ['person.quick.young', 22, years >= 16 && years < 30, 'young'],
        ['person.quick.adult', 40, years >= 30 && years < 60, 'adult'], ['person.quick.old', 72, years >= 60, 'old']] as const) {
        choice(a, t(key), on, () => become(randomPerson(person.id, seed(), { body: { gender: b.gender, age: ageFromYears(y) } })), icon);
      }
      const bl = row(into, t('person.quick.build'), 'build');
      for (const [key, muscle, weight, icon] of [['person.quick.slim', 0.3, 0.18, 'slim'], ['person.quick.average', 0.45, 0.45, 'average'],
        ['person.quick.athletic', 0.85, 0.38, 'athletic'], ['person.quick.heavy', 0.4, 0.88, 'heavy']] as const) {
        const on = Math.abs(b.muscle - muscle) < 0.08 && Math.abs(b.weight - weight) < 0.08;
        choice(bl, t(key), on, () => { setBody({ muscle, weight }); renderControls(); }, icon);
      }
      // Ready-made faces: the generator's faces for this very body, kept
      // with the person's own expression.
      const f = row(into, t('person.quick.faces'), 'faces');
      for (let k = 1; k <= 8; k++) {
        choice(f, `${t('person.quick.faces')} ${k}`, false, () => {
          const face = randomPerson(person.id, 7919 * k + Math.round(b.gender * 3) + Math.round(years), { body: b, look: person.look }).features;
          const expression = Object.fromEntries(EXPRESSION_SLIDERS.filter((n) => person.features[n] !== undefined).map((n) => [n, person.features[n]!]));
          person = { ...person, features: { ...face, ...expression } };
          queueShape();
        }, undefined, String(k));
      }
      swatches(into, t('person.skin'), 'tone', SKIN_TONES, person.look.skin, (c) => setLook({ skin: c }));
    })];

    const face: Page[] = [
      page('presets', t('person.section.quick'), 'presets', (into) => {
        // Each part of the face by its presets, numbered, as character creators offer them.
        for (const part of FACE_PARTS) {
          const r = row(into, t(`person.part.${part.key}`), `part_${part.key}`);
          part.presets.forEach((preset, i) => {
            const on = part.sliders.every((k) => (person.features[k] ?? 0) === (preset.values[k] ?? 0));
            choice(r, t(`person.preset.${part.key}.${preset.key}`), on, () => {
              person = { ...person, features: applyFacePreset(person.features, part, preset) };
              queueShape();
              renderControls();
            }, undefined, String(i + 1));
          });
        }
      }),
      page('detail', t('person.section.face'), 'detail', (into) => {
        for (const name of FACE_SLIDERS) slider(into, t(`person.f.${name}`), person.features[name] ?? 0, -1, 1, 0.02, (v) => setFeature(name, v), signed);
      }),
      page('expression', t('person.section.expression'), 'expression', (into) => {
        for (const name of EXPRESSION_SLIDERS) slider(into, t(`person.f.${name}`), person.features[name] ?? 0, -1, 1, 0.02, (v) => setFeature(name, v), signed);
      }),
    ];

    const bodyPages: Page[] = [
      page('macro', t('person.section.body'), 'macro', (into) => {
        slider(into, t('person.sex'), b.gender, 0, 1, 0.01, (v) => setBody({ gender: v }), (v) => (v < 0.35 ? '♀' : v > 0.65 ? '♂' : '⚥'), 'sex');
        slider(into, t('person.age'), Math.round(years), 1, 90, 1, (v) => setBody({ age: ageFromYears(v) }), (v) => `${v}`, 'age');
        slider(into, t('person.muscle'), b.muscle, 0, 1, 0.01, (v) => setBody({ muscle: v }), pct, 'athletic');
        slider(into, t('person.weight'), b.weight, 0, 1, 0.01, (v) => setBody({ weight: v }), pct, 'heavy');
        slider(into, t('person.height'), b.height, 0, 1, 0.01, (v) => setBody({ height: v }), pct, 'macro');
        slider(into, t('person.proportions'), b.proportions, 0, 1, 0.01, (v) => setBody({ proportions: v }), pct, 'shape');
        if (b.gender < 0.65) slider(into, t('person.bust'), b.cupsize, 0, 1, 0.01, (v) => setBody({ cupsize: v }), pct, 'female');
      }),
      page('shape', t('person.section.shape'), 'shape', (into) => {
        for (const name of BODY_SLIDERS) slider(into, t(`person.f.${name}`), person.features[name] ?? 0, -1, 1, 0.02, (v) => setFeature(name, v), signed);
      }),
      page('origin', t('person.section.origin'), 'origin', (into) => {
        for (const key of ['african', 'asian', 'caucasian'] as const) slider(into, t(`person.${key}`), b[key], 0, 1, 0.01, (v) => setBody({ [key]: v }), pct);
      }),
    ];

    const skinPages: Page[] = [
      page('tone', t('person.section.skin'), 'tone', (into) => {
        swatches(into, t('person.skin'), 'tone', SKIN_TONES, person.look.skin, (c) => setLook({ skin: c }));
        slider(into, t('person.melanin'), person.look.melanin ?? 0.5, 0, 1, 0.01, (v) => setPigment({ melanin: v }), pct, 'tone');
        slider(into, t('person.undertone'), person.look.undertone ?? 0.5, 0, 1, 0.01, (v) => setPigment({ undertone: v }), pct, 'skin');
      }),
      page('eyes', t('person.eyes'), 'eyeColour', (into) => {
        swatches(into, t('person.eyes'), 'eyeColour', EYE_COLOURS, person.look.eyes, (c) => setLook({ eyes: c }));
      }),
    ];

    const hairPages: Page[] = [
      page('hairstyle', t('person.hairstyle'), 'hairstyle', (into) => {
        if (dressed) gallery(into, hairFor(sex), person.look.hairCut, (n) => wear({ hairCut: n }), true);
        else {
          const r = row(into, t('person.style'), 'hairstyle');
          (['none', 'short', 'long'] as HairStyle[]).forEach((v, i) => choice(r, t(`person.option.${v}`), person.look.hairStyle === v, () => setLook({ hairStyle: v }), v === 'none' ? 'none' : undefined, String(i)));
        }
      }),
      page('colour', t('person.colour'), 'colour', (into) => {
        swatches(into, t('person.colour'), 'colour', HAIR_COLOURS, person.look.hair, (c) => setLook({ hair: c }));
        slider(into, t('person.makeup'), person.look.makeup ?? 0, 0, 1, 0.01, (makeup) => {
          person = { ...person, look: { ...person.look, makeup } };
          preview.setLook(person.look);
        }, pct, 'makeup');
      }),
    ];
    if (dressed) {
      const beards = itemsOf('beard');
      if (!female) hairPages.push(page('beard', t('person.beard'), 'beard', (into) => gallery(into, beards, (person.look.extras ?? []).find((n) => beards.includes(n)), (n) => wearExtra(beards, n), true)));
      hairPages.push(page('brows', t('person.brows'), 'brows', (into) => gallery(into, ALL_BROWS, person.look.brows, (n) => wear({ brows: n }))));
      hairPages.push(page('lashes', t('person.lashes'), 'lashes', (into) => gallery(into, ALL_LASHES, person.look.lashes, (n) => wear({ lashes: n }))));
    }

    const clothes: Page[] = [];
    const bottoms = [...itemsOf('bottom'), ...itemsOf('skirt')];
    clothes.push(page('outfit', t('person.outfit'), 'outfit', (into) => gallery(into, outfitsForAge(years, female ? WARDROBE.outfits.female : WARDROBE.outfits.male), person.look.outfit, (n) => wear({ outfit: n }))));
    if (adult) {
      clothes.push(page('top', t('person.top'), 'top', (into) => gallery(into, itemsOf('top', { sex }), person.look.outfit, (n) => wear({ outfit: n }))));
      clothes.push(page('bottom', t('person.bottom'), 'bottom', (into) => gallery(into, [...itemsOf('bottom', { sex }), ...(female ? itemsOf('skirt') : [])], (person.look.extras ?? []).find((n) => bottoms.includes(n)), (n) => wearExtra(bottoms, n), true)));
      if (female) clothes.push(page('dress', t('person.dress'), 'dress', (into) => gallery(into, itemsOf('dress'), person.look.outfit, (n) => wear({ outfit: n, extras: (person.look.extras ?? []).filter((x) => !bottoms.includes(x)) }))));
      clothes.push(page('suit', t('person.suit'), 'suit', (into) => gallery(into, itemsOf('suit', { sex }), person.look.outfit, (n) => wear({ outfit: n, extras: (person.look.extras ?? []).filter((x) => !bottoms.includes(x)) }))));
    }
    if (dressed) {
      clothes.push(page('dye', t('person.outfitColour'), 'dye', (into) => {
        const r = row(into, t('person.outfitColour'), 'dye');
        choice(r, t('person.ownColours'), person.look.outfitTint === null || person.look.outfitTint === undefined, () => wear({ outfitTint: null }), 'own');
        swatches(into, t('person.dye'), 'colour', CLOTH_COLOURS, person.look.outfitTint ?? -1, (c) => wear({ outfitTint: c }));
      }));
      clothes.push(page('footwear', t('person.footwear'), 'footwear', (into) => gallery(into, shoesFor(sex, WARDROBE.footwear), person.look.footwear, (n) => wear({ footwear: n }))));
      clothes.push(page('hat', t('person.hat'), 'hat', (into) => gallery(into, [...WARDROBE.hats.filter(() => !female), ...itemsOf('hat', { sex }), ...itemsOf('helmet')], person.look.hat, (n) => wear({ hat: n }), true)));
      for (const [kind, key] of [['glasses', 'person.glasses'], ['jewelry', 'person.jewelry'], ['gloves', 'person.gloves'], ['socks', 'person.socks'],
        ['underwear', 'person.underwear'], ['mask', 'person.mask'], ['horns', 'person.horns'], ['equipment', 'person.equipment']] as const) {
        const family = itemsOf(kind, { sex });
        if (family.length) clothes.push(page(kind, t(key), kind, (into) => gallery(into, family, (person.look.extras ?? []).find((n) => family.includes(n)), (n) => wearExtra(family, n), true)));
      }
    } else {
      clothes.push(page('simple', t('person.section.clothes'), 'top', (into) => {
        const tops = row(into, t('person.top'), 'top');
        (['none', 'tank', 'tshirt', 'longsleeve'] as TopStyle[]).forEach((v, i) => choice(tops, t(`person.option.${v}`), person.look.top === v, () => setLook({ top: v }), v === 'none' ? 'none' : undefined, String(i)));
        swatches(into, t('person.topColour'), 'colour', CLOTH_COLOURS, person.look.topColour, (c) => setLook({ topColour: c }));
        const bots = row(into, t('person.bottom'), 'bottom');
        (['trousers', 'shorts', 'skirt'] as BottomStyle[]).forEach((v, i) => choice(bots, t(`person.option.${v}`), person.look.bottom === v, () => setLook({ bottom: v }), undefined, String(i + 1)));
        swatches(into, t('person.bottomColour'), 'colour', CLOTH_COLOURS, person.look.bottomColour, (c) => setLook({ bottomColour: c }));
        swatches(into, t('person.shoes'), 'footwear', CLOTH_COLOURS, person.look.shoes, (c) => setLook({ shoes: c }));
      }));
    }

    return [
      { key: 'who', label: t('person.section.quick'), icon: 'who', pages: who },
      { key: 'face', label: t('person.section.face'), icon: 'face', pages: face },
      { key: 'body', label: t('person.section.body'), icon: 'body', pages: bodyPages },
      { key: 'skin', label: t('person.section.skin'), icon: 'skin', pages: skinPages },
      { key: 'hair', label: t('person.section.hair'), icon: 'hair', pages: hairPages },
      { key: 'clothes', label: t('person.section.clothes'), icon: 'clothes', pages: clothes },
      { key: 'saved', label: t('person.saved'), icon: 'saved', pages: [page('saved', t('person.saved'), 'saved', (into) => { into.appendChild(saved); renderSaved(); })] },
    ];
  };

  const renderControls = (): void => {
    const cats = categories();
    const cat = cats.find((c) => c.key === category) ?? cats[0]!;
    category = cat.key;
    rail.replaceChildren();
    for (const c of cats) {
      const b = el('button', 'pc-rail-b' + (c.key === cat.key ? ' active' : ''));
      b.type = 'button';
      b.innerHTML = creatorIcon(c.icon, 20);
      b.title = c.label;
      b.setAttribute('aria-label', c.label);
      b.setAttribute('aria-pressed', String(c.key === cat.key));
      b.addEventListener('click', () => { category = c.key; renderControls(); });
      rail.appendChild(b);
    }
    const current = cat.pages.find((p) => p.key === pageOf.get(cat.key)) ?? cat.pages[0]!;
    pages.replaceChildren();
    pages.hidden = cat.pages.length < 2;
    for (const p of cat.pages) {
      const b = el('button', 'pc-page' + (p.key === current.key ? ' active' : ''));
      b.type = 'button';
      b.innerHTML = creatorIcon(p.icon, 18);
      b.title = p.label;
      b.setAttribute('aria-label', p.label);
      b.setAttribute('aria-pressed', String(p.key === current.key));
      b.addEventListener('click', () => { pageOf.set(cat.key, p.key); renderControls(); });
      pages.appendChild(b);
    }
    const scroll = controls.scrollTop;
    controls.replaceChildren();
    current.build(controls);
    controls.scrollTop = scroll;
  };

  const renderSaved = (): void => {
    saved.replaceChildren();
    const people = host.people();
    if (people.length === 0) {
      // Nobody yet: an empty slot, the explanation in its tooltip.
      const empty = el('div', 'pc-empty');
      empty.innerHTML = creatorIcon('saved', 28);
      empty.title = t('person.savedNone');
      saved.appendChild(empty);
      return;
    }
    const list = el('div', 'pc-saved-list');
    for (const p of people) {
      const card = el('div', 'pc-card' + (p.id === person.id ? ' active' : ''));
      const open = el('button', 'pc-card-open');
      open.type = 'button';
      const chip = el('span', 'pc-card-chip');
      chip.style.background = `linear-gradient(90deg, ${hex(p.look.skin)} 0 34%, ${hex(p.look.topColour)} 34% 67%, ${hex(p.look.bottomColour)} 67%)`;
      open.append(chip, el('span', 'pc-card-name', p.name || `${t('person.unnamed')} ${p.id}`));
      open.addEventListener('click', () => {
        person = p;
        nameInput.value = p.name;
        preview.setLook(p.look);
        queueShape();
        renderControls();
        renderSaved();
      });
      const remove = el('button', 'pc-card-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `${t('person.remove')} ${p.name || p.id}`);
      remove.addEventListener('click', () => {
        host.remove(p.id);
        renderSaved();
      });
      card.append(open, remove);
      list.appendChild(card);
    }
    saved.appendChild(list);
  };
  const flashSaved = (): void => {
    saveButton.classList.add('flash');
    saveButton.innerHTML = creatorIcon('check', 18);
    setTimeout(() => {
      saveButton.classList.remove('flash');
      saveButton.innerHTML = creatorIcon('save', 18);
    }, 1300);
  };

  const relabel = (): void => {
    nameInput.placeholder = t('person.namePlaceholder');
    nameInput.setAttribute('aria-label', t('person.name'));
    randomButton.title = t('person.random');
    saveButton.title = t('person.save');
    newButton.title = t('person.new');
    for (const b of [randomButton, saveButton, newButton]) b.setAttribute('aria-label', b.title);
    walkButton.innerHTML = creatorIcon(walking ? 'stand' : 'walk', 18);
    walkButton.title = t(walking ? 'person.stand' : 'person.walk');
    if (!loaded) status.textContent = t('person.loading');
    renderControls();
    renderSaved();
    if (loaded) reshape();
  };

  root.append(actions, body);
  relabel();

  return {
    root,
    stage,
    activate() {
      preview.setActive(true);
      preview.show(person);
      if (!loaded) status.textContent = t('person.loading');
      renderSaved();
    },
    deactivate() {
      preview.setActive(false);
    },
    refresh() {
      renderSaved();
    },
    relabel,
  };
}
