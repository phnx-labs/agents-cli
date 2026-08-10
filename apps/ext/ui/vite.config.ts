import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

// Dev-server config picked up by bare `vite` (the `dev` script). The production
// bundles are built with explicit `--config vite.settings.config.ts` /
// `vite.editor.config.ts`, which take precedence and are unaffected by this file.
//
// This exists so the documented preview flow works:
//   bun run dev  ->  http://localhost:5173/settings/preview/?view=feed|launch
// Without the `@shared` alias below, `settings/components/mission-control/floorModel.ts`
// (`import ... from '@shared/project'`) 500s and the harness renders blank.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'settings'),
      '@shared': resolve(__dirname, '../src/shared'),
    },
  },
})
