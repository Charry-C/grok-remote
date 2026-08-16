import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface PackageJson { version?: string }

const pkg = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'package.json'),
  'utf8',
)) as PackageJson;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 7911,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7910',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
