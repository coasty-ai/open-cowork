import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React 19 requires this flag for act()-based testing utilities. RTL only sets
// it when test globals exist; we run with vitest globals disabled, so set it here.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// RTL auto-cleanup also relies on a global afterEach, which is unavailable
// without vitest globals — register it explicitly.
afterEach(() => {
  cleanup();
});
