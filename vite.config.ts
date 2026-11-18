import { defineConfig } from 'vite';
import { SITE_BASE_PATH } from './shared/site';
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'serve' && !isPreview ? '/' : SITE_BASE_PATH,
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true }
}));
