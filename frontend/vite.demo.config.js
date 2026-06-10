import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
  build: {
    outDir: '../website/demo',
    emptyOutDir: true,
    rollupOptions: { input: 'demo.html' },
  },
});
