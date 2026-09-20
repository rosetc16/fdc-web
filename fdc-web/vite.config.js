import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standard React + Vite config. Builds to /dist (static files) — deploy that anywhere.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split React out of the app bundle. It never changes between deploys, so once a visitor has it
        // cached they only re-download the app code — and this app ships often. (The much bigger win,
        // lazy-loading the draft room itself, needs App.jsx broken into modules first: DraftRoom alone is
        // ~7,000 of its ~21,000 lines and shares helpers with everything else, so it's a deliberate
        // refactor rather than a config change.)
        manualChunks: (id) => (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'react' : undefined),
      },
    },
  },
});
