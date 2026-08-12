import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { availableParallelism } from 'node:os';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './tests/__mocks__/server-only.ts'),
      'next/server': path.resolve(__dirname, './tests/__mocks__/next-server.ts'),
      'next/image': path.resolve(__dirname, './tests/__mocks__/next-image.tsx'),
      'next/link': path.resolve(__dirname, './tests/__mocks__/next-link.tsx'),
      'next/navigation': path.resolve(__dirname, './tests/__mocks__/next-navigation.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    maxWorkers: Math.min(8, Math.max(1, availableParallelism() - 1)),
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'tests/monarch-connector.test.ts'],
  },
});
