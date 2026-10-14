import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
  server: { host: '127.0.0.1', port: 5197, strictPort: true,
    fs: { deny: ['.env', '.env.*', '**/.git/**', '**/.impeccable/**', '**/research/**', '**/tools/**', '**/PRODUCT.md', '**/DESIGN.md'] } },
});
