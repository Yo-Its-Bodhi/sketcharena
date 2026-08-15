import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { proxy: { '/socket.io': { target: 'http://127.0.0.1:4100', ws: true }, '/api': 'http://127.0.0.1:4100', '/health': 'http://127.0.0.1:4100' } } });
