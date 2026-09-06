import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev-only: lets the app call /api/* without CORS juggling.
    proxy: { '/api': 'http://localhost:5000' },
  },
});
