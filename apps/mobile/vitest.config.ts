import { defineConfig } from 'vitest/config';

/**
 * The mobile screens are tested through react-native-web (DECISIONS.md D7):
 * the 'react-native' import is aliased to 'react-native-web', so the exact
 * components that ship to phones render as DOM in jsdom and are asserted
 * with @testing-library/react.
 */
export default defineConfig({
  resolve: {
    alias: {
      'react-native': 'react-native-web',
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**', 'App.tsx'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
