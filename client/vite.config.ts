import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Static assets (hero images, icon) belong in client/public — Vite copies them into
  // the build. The build emits to the repo-root public/ folder, which Vercel serves
  // from its CDN (express.static is ignored there) and `npm start` serves locally.
  publicDir: 'public',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
