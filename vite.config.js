import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Multi-page build. The main dashboard entry is `index.html` at the repo
// root (served at `/`) and the bookmark-only beta lab entry is
// `beta/index.html` (served at `/beta/`). Nothing in the built output
// links the two together — see beta/App.jsx for the rationale.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://aigamma.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        beta: fileURLToPath(new URL('./beta/index.html', import.meta.url)),
      },
    },
  },
})
