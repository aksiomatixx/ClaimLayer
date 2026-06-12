import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // Demo document PDFs are build INPUTS (frontend/public-demo/files/*),
  // copied into the output on every build — emptyOutDir wipes
  // website/demo, so nothing the demo needs may live only there.
  publicDir: 'public-demo',
  define: {
    'import.meta.env.VITE_DEMO': JSON.stringify('1'),
    // CL-MKT1: the public demo shows only the adjuster decision surface.
    'import.meta.env.VITE_SHOW_PORTAL_NAV': JSON.stringify('false'),
  },
  build: {
    outDir: '../website/demo',
    emptyOutDir: true,
    rollupOptions: { input: 'demo.html' },
  },
});
