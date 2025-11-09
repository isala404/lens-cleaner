import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, 'dashboard.html'),
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'content-scraper': resolve(__dirname, 'src/content/scraper.ts')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Service worker and content script in root, others in assets
          if (chunkInfo.name === 'service-worker' || chunkInfo.name === 'content-scraper') {
            return '[name].js';
          }
          return 'assets/[name].js';
        },
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
})
