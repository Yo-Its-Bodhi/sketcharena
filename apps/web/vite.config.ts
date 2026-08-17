import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, '.', '').SKETCH_SERVER_TARGET || 'http://127.0.0.1:4100';
  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            motion: ['framer-motion'],
            realtime: ['socket.io-client'],
            passkeys: ['@simplewebauthn/browser'],
          },
        },
      },
    },
    server: { proxy: { '/socket.io': { target, ws: true }, '/api': target, '/health': target } },
  };
});
