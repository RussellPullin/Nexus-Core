import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load Vite env from client/.env so browser vars (VITE_*) stay in one place.
  const env = loadEnv(mode, __dirname, '');
  const useHttps = env.VITE_DEV_HTTPS === 'true' || env.VITE_DEV_HTTPS === '1';

  return {
    plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
    envDir: __dirname,
    server: {
      port: Number(env.VITE_DEV_PORT) || 5174,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3080',
          changeOrigin: true,
        },
      },
    },
  };
});
