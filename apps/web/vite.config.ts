import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev + preview proxy the backend so the SPA can use same-origin '/api' URLs.
const backendProxy = {
  '/api': {
    target: 'http://127.0.0.1:4000',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: backendProxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy: backendProxy },
  build: { outDir: 'dist', sourcemap: false },
});
