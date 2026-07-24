import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Base path resolution. The mobile PWA is served from two places:
//   1. GitHub Pages at https://josephghaly7.github.io/mt5-mobile/  (build with GITHUB_PAGES=1)
//   2. FastAPI on the VM at /mobile/ via the Cloudflare tunnel
// The manifest's start_url and scope MUST match the base, otherwise iOS
// install-to-home-screen creates a broken PWA pinned at the wrong URL.
const BASE = process.env.GITHUB_PAGES ? '/mt5-mobile/' : '/mobile/'

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'MT5 Mobile',
        short_name: 'MT5',
        description: 'Live ES/EP futures charting on iPhone',
        theme_color: '#0a0e14',
        background_color: '#0a0e14',
        display: 'standalone',
        orientation: 'portrait',
        start_url: BASE,
        scope: BASE,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Network-first for HTML so updates land; cache-first for hashed assets.
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // /api/quote, /api/bars etc — short cache, network-first
            urlPattern: /^\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'mt5-api',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 }
            }
          }
        ]
      }
    })
  ],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:5558',
      '/ws': { target: 'ws://localhost:5558', ws: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false
  }
})
