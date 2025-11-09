/**
 * Copy ONNX Runtime WASM files to dist folder
 * This is necessary for transformers.js to work in Chrome extensions without CSP violations
 */

import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

// Ensure dist directory exists
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// ONNX Runtime WASM files from @huggingface/transformers
const onnxFiles = [
  'ort-wasm-simd.wasm',
  'ort-wasm-simd.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm.wasm',
  'ort-wasm.mjs',
  'ort-wasm-threaded.wasm',
  'ort-wasm-threaded.mjs'
];

const sourceDir = join(
  __dirname,
  '..',
  'node_modules',
  '@huggingface',
  'transformers',
  'dist'
);

console.log('Copying ONNX Runtime WASM files...');
console.log('Source:', sourceDir);
console.log('Destination:', distDir);

let copied = 0;
let skipped = 0;

for (const file of onnxFiles) {
  const sourcePath = join(sourceDir, file);
  const destPath = join(distDir, file);

  try {
    if (existsSync(sourcePath)) {
      copyFileSync(sourcePath, destPath);
      console.log(`✓ Copied: ${file}`);
      copied++;
    } else {
      console.log(`⚠ Skipped (not found): ${file}`);
      skipped++;
    }
  } catch (error) {
    console.error(`✗ Error copying ${file}:`, error.message);
  }
}

console.log(`\nDone! Copied ${copied} files, skipped ${skipped} files.`);
