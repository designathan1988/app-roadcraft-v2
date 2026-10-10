// App separado do FORMA 2 (o mesmo editor que o jogo incorpora).
import { createEditor } from '../editor/editor';

const editor = createEditor({ container: document.getElementById('app')! });

// API global compatível com o FORMA v1 (usada por testes e integrações).
(globalThis as Record<string, unknown>).Forma = {
  version: '2.0.0',
  editor,
  getProject: () => editor.getProject(),
  getSelection: () => editor.getSelection(),
  getView: () => editor.getView(),
  getStatistics: () => editor.getStatistics(),
  exportProject: () => editor.exportJSON(),
};
document.body.dataset.ready = 'true';
