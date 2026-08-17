import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { availableParallelism } from 'node:os';
import path from 'path';

const domTestFiles = [
  'tests/**/*.test.tsx',
  'tests/graph/ideation-store.test.ts',
  'tests/hooks/usePwaInstall.test.ts',
  'tests/hooks/useTaskCompletion.test.ts',
  'tests/hooks/useTaskFilterContext.test.ts',
  'tests/hooks/useTaskSelection.test.ts',
  'tests/hooks/useTimer.test.ts',
  'tests/hooks/useTodayActions.test.ts',
  'tests/hooks/useVoiceCapture.test.ts',
  'tests/notifications/external-navigation.test.ts',
  'tests/notifications/useNotifications-pagination.test.ts',
  'tests/quick-add-list-typeahead.test.ts',
  'tests/quick-add-preferences.test.ts',
  'tests/settings-search.test.ts',
  'tests/unit/haptics.test.ts',
];

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
    setupFiles: ['./tests/setup.ts'],
    maxWorkers: Math.min(8, Math.max(1, availableParallelism() - 1)),
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: [
            ...domTestFiles,
            'tests/e2e/**',
            'tests/monarch-connector.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          testTimeout: 10_000,
          include: domTestFiles,
          exclude: ['tests/e2e/**'],
        },
      },
    ],
  },
});
