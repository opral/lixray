import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {alias: {'#binding': fileURLToPath(new URL('./identity-investigation-binding.ts', import.meta.url))}},
  worker: {plugins: () => [{name: 'investigation-binding', enforce: 'pre' as const, resolveId(id: string) { if (id === '#binding') return fileURLToPath(new URL('./identity-investigation-binding.ts', import.meta.url)); }}]},
  test: {include: ['src/worker/identity-investigation.browser.test.ts'], browser: {enabled: true, headless: true, provider: playwright(), instances: [{browser: 'chromium'}]}},
});
