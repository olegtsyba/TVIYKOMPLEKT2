import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        '/api/keycrm': {
          target: 'https://tviykomplekt-88100.web.app',
          changeOrigin: true,
        },
        '/api/order': {
          target: 'https://tviykomplekt-88100.web.app',
          changeOrigin: true,
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve('.'),
      }
    }
});