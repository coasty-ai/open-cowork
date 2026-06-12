/**
 * Backend base URL for the mobile app.
 *
 * Expo inlines `process.env.EXPO_PUBLIC_*` references at bundle time (native
 * and web); vitest/Node provide `process.env` directly. The fallback targets
 * the local dev backend (apps/backend listens on 4000).
 */
declare const process: { env: Record<string, string | undefined> };

const fromEnv =
  typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_BACKEND_URL : undefined;

export const BACKEND_URL: string = (
  fromEnv && fromEnv.length > 0 ? fromEnv : 'http://127.0.0.1:4000'
).replace(/\/+$/, '');
