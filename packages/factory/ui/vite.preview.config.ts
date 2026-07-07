import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Standalone build of the visual preview harness (settings/preview/index.html).
// base './' so the built bundle loads over file:// for screenshotting.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'settings',
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'settings'),
    },
  },
  build: {
    outDir: '../.tmp/preview-dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'settings/preview/index.html'),
      onwarn(warning, warn) {
        if (warning.code === 'MISSING_EXPORT') return
        warn(warning)
      },
    },
  },
})
