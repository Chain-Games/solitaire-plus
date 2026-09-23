import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { hashedPublic } from './hashed-public.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
/** Where `/api` is proxied in dev and preview; override to point at another API instance. */
const API = process.env['API_URL'] ?? 'http://localhost:3030';

/**
 * index.html's social-card tags need absolute URLs, so they carry a
 * __PUBLIC_URL__ token. Production leaves it for the server to fill from
 * PUBLIC_URL at serve time; the dev server fills it here so local pages are
 * never shipped with the literal token.
 */
function publicUrlToken(): Plugin {
  return {
    name: 'solitaire:public-url',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.replaceAll('__PUBLIC_URL__', process.env['PUBLIC_URL'] ?? 'http://localhost:5373'),
  };
}

export default defineConfig({
  plugins: [react(), publicUrlToken(), hashedPublic()],
  server: {
    port: 5373,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      // Share pages are server-rendered (/s/:id and its PNGs); anchored so /src is never caught.
      '^/s/': { target: API, changeOrigin: false },
    },
  },
  preview: {
    port: 4379,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '^/s/': { target: API, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      // admin.html is a second page (the admin dashboard): no React, no game
      // code, served as a real file so the SPA fallback never sees it.
      input: { main: here('index.html'), admin: here('admin.html') },
      output: {
        manualChunks: { pixi: ['pixi.js'], react: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
});
