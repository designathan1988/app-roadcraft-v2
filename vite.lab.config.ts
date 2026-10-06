import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

/**
 * The weapons lab's server (`?lab=armas`, `scripts/weapons-lab.mjs`): the
 * game's own config, but nothing watched and no hot reload, so a recording
 * is never cut short by another edit to the repository (the dev server
 * reloads the page on every save). Restart it to load new code.
 */
export default mergeConfig(base, defineConfig({
  server: { port: 5190, strictPort: true, hmr: false, watch: null },
}));
