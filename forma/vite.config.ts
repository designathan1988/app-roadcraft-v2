import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// App separado: embute o three e gera um HTML único, como o FORMA original.
export default defineConfig({
  root: 'src/app',
  // Texturas PBR servidas ao lado do app (não embutidas no HTML).
  publicDir: 'public',
  plugins: [viteSingleFile()],
  build: {
    outDir: '../../dist-app',
    emptyOutDir: true,
  },
  test: {
    root: '.',
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
