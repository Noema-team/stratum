import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  base: '/app/',
  root: path.resolve(import.meta.dirname),
  build: { outDir: path.resolve(import.meta.dirname, '../public/app'), emptyOutDir: true },
});
