import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildProxyConfig } from './dev-proxy';

// Dev + preview proxy the backend so the SPA can use same-origin '/api' URLs.
// Target is resolved from COWORK_BACKEND_URL / COWORK_PORT (not hard-coded), and
// a friendly handler turns "backend not up yet" into one throttled log line + a
// clean 503 instead of an ECONNREFUSED stack-trace flood. See ./dev-proxy.ts.
const backendProxy = buildProxyConfig();

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: backendProxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: backendProxy },
  build: { outDir: 'dist', sourcemap: false },
});
