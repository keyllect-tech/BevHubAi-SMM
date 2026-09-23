import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load the whole .env (not just VITE_*) so the dev proxy follows the backend's PORT.
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.API_PROXY_TARGET || `http://localhost:${env.PORT || 3001}`;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      // Same-origin API in dev: session cookies stay first-party and no CORS is involved.
      proxy: { '/api': backend },
    },
    optimizeDeps: {
      exclude: ['lucide-react'],
    },
  };
});
