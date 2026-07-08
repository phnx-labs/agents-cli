import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'settings',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'settings'),
      // Types + pure logic shared with the extension host, imported by BOTH roots
      // instead of hand-mirrored. See src/shared/.
      '@shared': resolve(__dirname, '../src/shared'),
    }
  },
  build: {
    outDir: '../../out/ui/settings',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'settings/index.html'),
      output: {
        entryFileNames: 'main.js',
        assetFileNames: 'main.[ext]'
      },
      onwarn(warning, warn) {
        if (warning.code === 'MISSING_EXPORT') {
          // A missing export FROM the shared contract (src/shared) is real drift —
          // the class that made the backlog `project` field vanish. Fail the build.
          // Other MISSING_EXPORT warnings are pre-existing type-as-value imports the
          // app tolerates (esbuild erases the type), so keep suppressing those.
          const from = `${warning.exporter ?? ''} ${warning.message ?? ''}`
          if (from.includes('src/shared')) {
            throw new Error(`Rollup MISSING_EXPORT from shared contract: ${warning.message}`)
          }
          return
        }
        warn(warning)
      }
    }
  }
})
