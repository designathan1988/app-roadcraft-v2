// Testes de ponta a ponta no app real, com mouse e teclado de verdade.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = (name: string) => resolve(import.meta.dirname, '../test/fixtures/v1', name + '.json');

/** Converte ponto do mundo em coordenadas de tela usando a câmera do editor. */
async function screen(page: Page, x: number, y: number, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, y, z]) => {
    const cam = (globalThis as any).Forma.editor.scene.camera;
    const V = cam.position.constructor;
    const r = document.querySelector('canvas')!.getBoundingClientRect();
    const q = new V(x, y, z).project(cam);
    return { x: r.left + (q.x * 0.5 + 0.5) * r.width, y: r.top + (-0.5 * q.y + 0.5) * r.height };
  }, [x, y, z]);
}

async function dragWorld(page: Page, a: [number, number, number], b: [number, number, number]) {
  const p = await screen(page, ...a),
    q = await screen(page, ...b);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 });
  await page.mouse.move(q.x, q.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

const project = (page: Page) => page.evaluate(() => (globalThis as any).Forma.getProject());
const toast = (page: Page) => page.locator('#toast').textContent();

async function open(page: Page, errors: string[]) {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().includes('Multiple instances of Three.js')) errors.push(m.text());
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
}

/** Coloca a câmera numa vista padrão (o enquadramento depende do projeto). */
async function view(page: Page, target: [number, number, number], distance: number) {
  await page.evaluate(
    ([t, d]) => {
      const sc = (globalThis as any).Forma.editor.scene;
      sc.target.set(...(t as number[]));
      sc.distance = d;
      sc.theta = 0.68;
      sc.phi = 1.0;
      sc.updateCamera();
    },
    [target, distance] as const,
  );
}

test('abre com o exemplo, sem erros e com a interface em português', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await expect(page.locator('#status-metric')).toHaveText('5 volumes · 1.457 m²');
  await expect(page.locator('[data-tab="materials"]')).toBeHidden();
  await page.locator('#ui-level').click();
  await expect(page.locator('[data-tab="materials"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('desenhar, puxar altura, mover, desfazer e refazer', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await view(page, [-30, 0, 30], 60);
  await page.keyboard.press('b');
  await dragWorld(page, [-38, 0, 24], [-26, 0, 32]);
  let p = await project(page);
  expect(p.buildings).toHaveLength(6);
  const b = p.buildings[5];
  expect(b.position).toEqual([-32, 28]);
  await expect(page.locator('#status-metric')).toContainText('6 volumes');
  // Alça de altura: 2 andares acima.
  const top = 9.6 + 2.2;
  const h = await screen(page, -32, top, 28);
  const h2 = await screen(page, -32, top + 6.4, 28);
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h2.x, h2.y, { steps: 6 });
  await page.mouse.up();
  p = await project(page);
  expect(p.buildings[5].storeys).toHaveLength(5);
  await expect(page.locator('#floors-input')).toHaveValue('5');
  // Mover com G.
  await page.keyboard.press('g');
  await dragWorld(page, [-32, 0, 28], [-28, 0, 28]);
  p = await project(page);
  expect(p.buildings[5].position).toEqual([-28, 28]);
  await page.keyboard.press('Control+z');
  expect((await project(page)).buildings[5].position).toEqual([-32, 28]);
  await page.keyboard.press('Control+Shift+z');
  expect((await project(page)).buildings[5].position).toEqual([-28, 28]);
  expect(errors).toEqual([]);
});

test('recortar, espelhar e girar mantêm a parte no lugar', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await page.locator('#ui-level').click();
  await view(page, [-30, 0, 30], 60);
  await page.keyboard.press('b');
  await dragWorld(page, [-40, 0, 26], [-22, 0, 30]);
  await page.keyboard.press('c');
  await dragWorld(page, [-32, 0, 22], [-30, 0, 34]);
  await expect(page.locator('#toast')).toHaveText('Volume dividido.');
  let p = await project(page);
  const part = p.buildings.at(-1);
  const center = [...part.position];
  await page.locator('#layers-toggle').click();
  await page.locator(`[data-select="${part.id}"]`).click();
  await page.locator('#layers-toggle').click();
  await page.locator('#shelf-content [data-action="mirror"]').click();
  p = await project(page);
  expect(p.buildings.find((b: any) => b.id === part.id).position).toEqual(center);
  await page.locator('[data-tab="details"]').click();
  await page.locator('#shelf-content input[data-prop="rotation"]').fill('90');
  await page.locator('#shelf-content input[data-prop="rotation"]').press('Tab');
  p = await project(page);
  const rotated = p.buildings.find((b: any) => b.id === part.id);
  expect(rotated.rotation).toBe(90);
  expect(rotated.position[0]).toBeCloseTo(center[0], 6);
  expect(rotated.position[1]).toBeCloseTo(center[1], 6);
  expect(errors).toEqual([]);
});

test('janela arrastada e porta por clique numa face', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await view(page, [-30, 5, 30], 40);
  await page.keyboard.press('b');
  await dragWorld(page, [-38, 0, 26], [-26, 0, 32]);
  // Face voltada para +z (z = 32), vista de frente pela câmera.
  await page.locator('[data-mode="face"]').click();
  await page.locator('[data-tab="facades"]').click();
  await page.locator('#shelf-content [data-tool="window"]').click();
  await dragWorld(page, [-34, 4, 32.2], [-32, 5.8, 32.2]);
  await expect(page.locator('#toast')).toHaveText('Abertura desenhada na parede.');
  await page.locator('#shelf-content [data-tool="door"]').click();
  const d = await screen(page, -29, 8, 32.2);
  await page.mouse.click(d.x, d.y);
  const b = (await project(page)).buildings.at(-1);
  const kinds = b.openings.map((o: any) => [o.fill.type, +o.width.toFixed(2), +o.height.toFixed(2), +o.sill.toFixed(3)]);
  expect(kinds[0][0]).toBe('window');
  expect(kinds[0][1]).toBeCloseTo(2, 0);
  expect(kinds[1]).toEqual(['door', 1.35, 2.4, 0.015]);
  expect(errors).toEqual([]);
});

test('importar v1, exportar GLB instanciado e reabrir com GLTFLoader', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await page.locator('#file-input').setInputFiles(fixture('openings'));
  await expect(page.locator('#toast')).toHaveText('Projeto aberto.');
  const p = await project(page);
  expect(p.schema).toBe('forma/2');
  expect(p.buildings[0].openings).toHaveLength(3);
  const root = resolve(import.meta.dirname, '..').split('\\').join('/');
  const result = await page.evaluate(async (root) => {
    const buf: ArrayBuffer = await (globalThis as any).Forma.editor.exportGLB();
    const mod = await import(/* @vite-ignore */ '/@fs/' + root + '/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const gltf: any = await new Promise((res, rej) => new mod.GLTFLoader().parse(buf, '', res, rej));
    let instanced = 0;
    gltf.scene.traverse((o: any) => o.isInstancedMesh && instanced++);
    const dv = new DataView(buf);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, dv.getUint32(12, true))));
    return { instanced, ext: json.extensionsUsed };
  }, root);
  expect(result.ext).toContain('EXT_mesh_gpu_instancing');
  expect(result.instanced).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('salvamento: recarregar mantém o projeto e migra o salvamento v1', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await page.locator('#project-name').fill('Meu Teste Ç');
  await page.locator('#project-name').press('Tab');
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  await expect(page.locator('#project-name')).toHaveValue('Meu Teste Ç');
  const v1 = readFileSync(fixture('courtyard'), 'utf8');
  await page.evaluate((j) => {
    localStorage.removeItem('forma_project_v2');
    localStorage.setItem('forma_project_v1', j);
  }, v1);
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
  const p = await project(page);
  expect(p.name).toBe('Pátio e U');
  expect(p.buildings[1].masses[0].holes).toHaveLength(1);
  expect(await page.evaluate(() => !!localStorage.getItem('forma_project_v1'))).toBe(true);
  expect(errors).toEqual([]);
});

test('mapa vazio pode ser desfeito com Ctrl+Z', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await page.locator('#new').click();
  await page.locator('[data-modal="empty"]').click();
  await expect(page.locator('#status-metric')).toHaveText('0 volumes · 0 m²');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#status-metric')).toHaveText('5 volumes · 1.457 m²');
  expect(errors).toEqual([]);
});

test('incorporado numa cena three.js externa, sem cópia duplicada do three', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().includes('Multiple instances of Three.js')) errors.push(m.text());
  });
  await page.goto('/host-scene.html');
  await page.waitForSelector('body[data-ready="true"]');
  const names = await page.evaluate(() => (globalThis as any).hostDemo.scene.children.map((c: any) => c.name || c.type));
  expect(names).toContain('FORMA-editor');
  await page.getByRole('button', { name: 'Gerar prédio pronto' }).click();
  await expect(page.locator('#log')).toHaveText('Prédio gerado (1).');
  expect(errors).toEqual([]);
});

test('base livre por cliques e vértice pego a 6 px da alça', async ({ page }) => {
  const errors: string[] = [];
  await open(page, errors);
  await view(page, [-30, 0, 30], 60);
  await page.keyboard.press('p');
  for (const [x, z] of [[-40, 20], [-28, 20], [-28, 30], [-36, 34], [-40, 20]] as const) {
    const s = await screen(page, x, 0, z);
    await page.mouse.click(s.x, s.y);
  }
  let p = await project(page);
  expect(p.buildings).toHaveLength(6);
  const b = p.buildings[5];
  expect(b.masses[0].outer.vertices).toHaveLength(4);
  await page.locator('#shelf-content [data-tool="editpoints"]').click();
  // Vértice em (-36, 34) no mundo; o clique começa 6 px ao lado da alça.
  const v = await screen(page, -36, 0.1, 34);
  const to = await screen(page, -39, 0.1, 37);
  await page.mouse.move(v.x + 6, v.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  p = await project(page);
  const moved = p.buildings[5];
  const world = moved.masses[0].outer.vertices.map((x: any) => [x.p[0] + moved.position[0], x.p[1] + moved.position[1]]);
  expect(world).toContainEqual([-39, 37]);
  expect(errors).toEqual([]);
});
