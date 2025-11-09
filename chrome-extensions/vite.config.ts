import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

// https://vite.dev/config/
export default defineConfig({
	plugins: [tailwindcss(), svelte()],
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

					return 'assets/[name]-[hash].js';
				},
				chunkFileNames: 'assets/[name]-[hash].js',
				assetFileNames: (assetInfo) => {
					// Keep WASM files in root for easier loading
					if (assetInfo.name && assetInfo.name.endsWith('.wasm')) {
						return '[name].[ext]';
					}

					return 'assets/[name]-[hash].[ext]';
				},
				inlineDynamicImports: false,
				manualChunks: undefined
			}
		},
		target: 'esnext',
		minify: false,
		// Ensure WASM files are copied
		assetsInlineLimit: 0
	},
	worker: { format: 'es' },
	optimizeDeps: { exclude: ['@huggingface/transformers'] }
});
