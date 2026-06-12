import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// react-native-web's virtualized lists may schedule work with setImmediate,
// which jsdom does not provide. Polyfill it on top of setTimeout.
const g = globalThis as unknown as {
  setImmediate?: (fn: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
  clearImmediate?: (handle: unknown) => void;
};
if (typeof g.setImmediate !== 'function') {
  g.setImmediate = (fn, ...args) => setTimeout(() => fn(...args), 0);
  g.clearImmediate = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);
}

// Vitest runs without injected globals (tests import {it,expect} explicitly),
// so @testing-library/react cannot auto-register its cleanup hook.
afterEach(() => {
  cleanup();
});
