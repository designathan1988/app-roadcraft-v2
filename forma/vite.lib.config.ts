import { defineConfig } from 'vite';

// Biblioteca para o jogo: o three fica de fora e vem do próprio jogo
// (evita duas cópias e o alerta "Multiple instances of Three.js").
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: { forma: 'src/index.ts', core: 'src/core/index.ts' },
      formats: ['es'],
    },
    rolldownOptions: {
      external: (id: string) => id === 'three' || id.startsWith('three/'),
    },
  },
});
