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
      '@shared': resolve(__dirname, '../src/shared'),
    },
  },
  build: {
    outDir: '../.tmp/preview-dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'settings/preview/index.html'),
      onwarn(warning, warn) {
        if (warning.code === 'MISSING_EXPORT') {
          const from = `${warning.exporter ?? ''} ${warning.message ?? ''}`
          if (from.includes('src/shared')) {
            throw new Error(`Rollup MISSING_EXPORT from shared contract: ${warning.message}`)
          }
          return
        }
        warn(warning)
      },
    },
  },
})
