// App do FORMA 3 (editor completo).
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { loadKernel } from '../f3/kernel/kernel';
import { Editor3 } from '../f3/editor/editor';
import { project } from '../f3/model/defaults';
import { sampleBuildings } from '../f3/model/samples';
import type { Project3 } from '../f3/model/schema';
import { mountInspector } from '../f3/ui/inspector';
import { mountCatalog } from '../f3/ui/catalog';

await loadKernel(wasmUrl);
let initial: Project3 | undefined;
try {
  const raw = localStorage.getItem('forma3_project');
  if (raw) initial = JSON.parse(raw) as Project3;
} catch {
  initial = undefined;
}
initial ??= project({ name: 'Exemplos', buildings: sampleBuildings() });
const editor = new Editor3(document.getElementById('app')!, { project: initial });
mountInspector(editor);
mountCatalog(editor);
(globalThis as { forma3?: Editor3 }).forma3 = editor;
