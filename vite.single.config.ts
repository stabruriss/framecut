import react from '@vitejs/plugin-react';
import type { OutputAsset } from 'rollup';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const renameSingleHtml = (): Plugin => ({
  name: 'framecut:rename-single-html',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const sourceName = 'single.html';
    const targetName = 'Framecut.html';
    const html = bundle[sourceName] as OutputAsset | undefined;

    if (!html) {
      this.error(`Expected ${sourceName} in the single-file bundle.`);
      return;
    }

    delete bundle[sourceName];
    html.fileName = targetName;
    bundle[targetName] = html;
  },
});

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [
    react(),
    viteSingleFile({
      removeViteModuleLoader: true,
    }),
    renameSingleHtml(),
  ],
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    rollupOptions: {
      input: 'single.html',
    },
  },
  worker: {
    format: 'iife',
  },
});
