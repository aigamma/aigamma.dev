import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Multi-page build. Four entries: the main dashboard at `index.html`
// (served at `/`), the bookmark-only three-slot beta lab at
// `beta/index.html` (served at `/beta/`), the bookmark-only single-slot
// alpha lab at `alpha/index.html` (served at `/alpha/`), and the
// bookmark-only single-slot dev lab at `dev/index.html` (served at
// `/dev/`). The dev lab is a peer scratch pad to /alpha — same pre-β
// release stage, independent concept — so a component maturing in
// either single-slot surface can promote into a beta slot on the same
// terms. Nothing in the built output links the four together — see
// beta/App.jsx, alpha/App.jsx, and dev/App.jsx for the rationale.
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
        alpha: fileURLToPath(new URL('./alpha/index.html', import.meta.url)),
        dev: fileURLToPath(new URL('./dev/index.html', import.meta.url)),
      },
    },
  },
})
