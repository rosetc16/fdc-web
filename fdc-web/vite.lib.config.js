/* ⭐⭐⭐⭐ A NODE-IMPORTABLE BUILD OF THE APP'S SCORING FUNCTIONS — 29bb.
   App.jsx is 43k lines of JSX and node cannot read it, which has meant that every number this app
   computes was reachable only through a browser. That is why a broken power rating survived 29w and 29y,
   and why the injury model — which moves those same numbers — needed a way to be tested that does not
   involve starting Chrome. This config builds the module as a library with React left external, so a
   plain node script can import `leaguePower`, `hubPoolFor` and `injCtxFor` and assert on real output.
   ⚠ IT IS A TEST ARTEFACT AND SHIPS NOTHING. The production build still uses vite.config.js. */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: {
    lib: { entry: 'src/App.jsx', formats: ['es'], fileName: 'app-lib' },
    outDir: '../../probe/lib',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'] },
  },
});
