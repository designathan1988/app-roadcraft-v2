// App do FORMA 3 (editor completo).
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { loadKernel } from '../f3/kernel/kernel';
import { Editor3 } from '../f3/editor/editor';
import { project } from '../f3/model/defaults';
import { sampleBuildings } from '../f3/model/samples';
import type { Project3 } from '../f3/model/schema';
import { mountInspector } from '../f3/ui/inspector';
import { mountCatalog } from '../f3/ui/catalog';
import { mountLayers } from '../f3/ui/layers';
import { mountPalette } from '../f3/ui/palette';
import { loadAutosave, saveFile, openFileWithNotes, download, fileName } from '../f3/io/persist';
import { exportGLB, exportOBJ, exportGameJSON } from '../f3/io/export';

await loadKernel(wasmUrl);
let initial: Project3 | undefined;
try {
  const r = loadAutosave();
  initial = r.project ?? undefined;
} catch {
  initial = undefined;
}
initial ??= project({ name: 'Exemplos', buildings: sampleBuildings() });
const editor = new Editor3(document.getElementById('app')!, { project: initial });
mountInspector(editor);
mountCatalog(editor);
mountLayers(editor);
mountPalette(editor);
(globalThis as { forma3?: Editor3 }).forma3 = editor;

const root = editor.shell.root;
const fileInput = root.querySelector<HTMLInputElement>('[data-file="project"]')!;
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (!f) return;
  try {
    const m = await openFileWithNotes(f);
    editor.store.replace(m.project, 'Projeto aberto.');
    editor.shell.name.value = m.project.name;
    editor.enter(null);
    editor.view.frame();
    editor.toast(m.notes.length ? `Projeto aberto (${m.notes.length} ajuste(s) na conversão).` : 'Projeto aberto.');
  } catch (e) {
    editor.toast(`Não foi possível abrir: ${(e as Error).message}`);
  }
});

function exportMenu(anchor: HTMLElement): void {
  document.querySelector('.f3-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'f3-menu';
  const items: [string, string, () => Promise<void> | void][] = [
    ['Modelo 3D (GLB)', '.glb', async () => download(await exportGLB(editor.project), fileName(editor.project.name, 'glb'), 'model/gltf-binary')],
    ['Geometria (OBJ)', '.obj', async () => download(await exportOBJ(editor.project), fileName(editor.project.name, 'obj'), 'text/plain')],
    ['Para o jogo (JSON)', '.json', () => download(exportGameJSON(editor.project), fileName(editor.project.name + '-jogo', 'json'), 'application/json')],
    ['Imagem da vista (PNG)', '.png', () => {
      editor.view.look.render();
      editor.view.renderer.domElement.toBlob((b) => b && download(b, fileName(editor.project.name, 'png'), 'image/png'));
    }],
    ['Projeto editável (JSON)', '.json', () => saveFile(editor.project)],
  ];
  m.innerHTML = items.map(([l, ext], i) => `<button data-i="${i}">${l}<small>${ext}</small></button>`).join('');
  root.appendChild(m);
  const r = anchor.getBoundingClientRect(),
    rr = root.getBoundingClientRect();
  m.style.left = `${Math.min(r.left - rr.left, rr.width - 240)}px`;
  m.style.top = `${r.bottom - rr.top + 4}px`;
  m.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.addEventListener('click', async () => {
      m.remove();
      try {
        editor.toast('Exportando…');
        await items[Number(b.dataset.i)]![2]();
        editor.toast('Exportado.');
      } catch (e) {
        editor.toast(`Falhou: ${(e as Error).message}`);
      }
    }),
  );
  setTimeout(() => document.addEventListener('pointerdown', (e) => !m.contains(e.target as Node) && m.remove(), { once: true }), 0);
}

editor.topCommand = (cmd) => {
  const btn = root.querySelector<HTMLElement>(`[data-cmd="${cmd}"]`)!;
  if (cmd === 'new') {
    editor.store.replace(project(), 'Projeto novo.');
    editor.shell.name.value = 'Projeto sem título';
    editor.enter(null);
    editor.view.frame();
    editor.toast('Projeto novo. Ctrl+Z volta ao anterior.');
    return true;
  }
  if (cmd === 'open') {
    fileInput.click();
    return true;
  }
  if (cmd === 'save') {
    saveFile(editor.project);
    editor.toast('Projeto salvo (.json).');
    return true;
  }
  if (cmd === 'export') {
    exportMenu(btn);
    return true;
  }
  if (cmd === 'templates') {
    editor.store.replace(project({ name: 'Exemplos', buildings: sampleBuildings() }), 'Exemplos carregados.');
    editor.view.frame();
    editor.toast('Exemplos carregados. Ctrl+Z volta.');
    return true;
  }
  return false;
};
editor.saveRequested = () => editor.topCommand?.('save');
