# Lens Cleaner

AI-powered duplicate photo detector built with Svelte and Transformers.js

## Features

- 🤖 **AI-Powered Detection**: Uses CLIP (Contrastive Language-Image Pre-training) model for accurate image similarity detection
- 🔒 **Privacy First**: All processing happens locally in your browser - no server required
- 📊 **Smart Grouping**: Groups similar photos based on visual similarity and temporal proximity
- 🎨 **Beautiful UI**: Modern, responsive interface with purple gradient design
- 💾 **Persistent Storage**: Uses IndexedDB to store photos and analysis results
- ⚡ **Fast & Efficient**: Optimized performance with separate embeddings storage

## How It Works

1. **Upload Photos**: Select photos from your computer
2. **AI Analysis**: CLIP model generates 512-dimensional embeddings for each photo
3. **Grouping**: Photos are grouped by similarity (configurable threshold) and time taken
4. **Review & Delete**: Select and delete duplicate photos

## Technical Stack

- **Frontend**: Svelte 5 + TypeScript
- **Build Tool**: Vite
- **AI Model**: CLIP (via Transformers.js)
- **Storage**: IndexedDB
- **Styling**: Scoped CSS with modern gradients

## Getting Started

### Prerequisites

- Node.js 18+ (or Bun)
- Modern web browser with IndexedDB support

### Installation

```bash
# Install dependencies
npm install
# or
bun install
```

### Development

```bash
# Start development server
npm run dev
# or
bun dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build

```bash
# Build for production
npm run build
# or
bun run build

# Preview production build
npm run preview
# or
bun preview
```

### Chrome Extension

To use as a Chrome extension:

1. Build the project:

   ```bash
   npm run build
   ```

2. Open Chrome and go to `chrome://extensions/`

3. Enable "Developer mode" (toggle in top right)

4. Click "Load unpacked"

5. Select the `dist` folder from this project

6. The extension icon will appear in your toolbar - click it to open the popup!

## Usage

### 1. Upload Photos

Click the "Upload Photos" button and select images from your computer. The app supports all common image formats (JPEG, PNG, WebP, etc.).

### 2. Calculate AI Embeddings

Once photos are uploaded, click "Calculate AI" to analyze them. The first time you run this, the CLIP model (~100MB) will be downloaded and cached.

### 3. Group Similar Photos

After embeddings are calculated, click "Group Photos" to find similar images. You can adjust the similarity threshold in settings:

- **Higher threshold (>0.9)**: Only very similar photos are grouped
- **Lower threshold (<0.8)**: More loosely related photos are grouped

### 4. Review and Delete

- Click photos to select them
- Use "Select All" to select all photos in a group
- Click "Delete Selected" to remove photos from the database

## Configuration

### Settings

Access settings by clicking the ⚙️ icon:

- **Similarity Threshold** (0.7-0.98): How similar photos must be to group together
- **Time Window** (5-1440 minutes): Maximum time between photos in a group

### Advanced

The app stores all data in IndexedDB under the database name `LensCleanerDB`. You can clear all data using the "Clear All Data" button.

## Architecture

```
frontend/
├── src/
│   ├── lib/
│   │   ├── db.ts              # IndexedDB wrapper
│   │   ├── embeddings.ts      # CLIP model integration
│   │   └── grouping.ts        # Photo grouping algorithm
│   ├── stores/
│   │   └── appStore.ts        # Svelte stores for state management
│   ├── App.svelte             # Main application component
│   ├── app.css                # Global styles
│   └── main.ts                # Application entry point
├── index.html
├── package.json
└── vite.config.ts
```

### Key Components

- **Database (db.ts)**: Manages IndexedDB with 4 object stores (photos, embeddings, groups, metadata)
- **Embeddings (embeddings.ts)**: Wraps Transformers.js CLIP model for feature extraction
- **Grouping (grouping.ts)**: Implements similarity-based photo grouping algorithms
- **App Store (appStore.ts)**: Central state management with actions for all operations

## Performance

- **Model Loading**: ~1-2 minutes on first use (model is cached)
- **Embedding Calculation**: ~0.5-2 seconds per photo (depends on device)
- **Grouping**: ~100-1000ms for 100 photos
- **Storage**: ~50-200KB per photo (thumbnail + embedding)

## Browser Compatibility

- Chrome/Edge 90+
- Firefox 88+
- Safari 15+

Requires:

- IndexedDB support
- WebAssembly support
- ES2020+ JavaScript

## Privacy & Security

**All processing happens locally in your browser:**

- Photos never leave your device
- No server-side processing
- No tracking or analytics
- Data stored only in your browser's IndexedDB

## Troubleshooting

### Model download fails

- Check your internet connection
- Clear browser cache and retry
- Try a different browser

### Out of memory errors

- Reduce the number of photos
- Close other browser tabs
- Increase browser memory limit (in browser flags)

### Photos not appearing

- Check browser console for errors
- Verify IndexedDB is enabled
- Try clearing all data and re-uploading

## Development

### Type Checking

```bash
npm run check
```

### Project Structure

The project follows standard Svelte practices with TypeScript for type safety. Key patterns:

- **Stores**: Reactive state management using Svelte stores
- **Async Operations**: Promises for all database and AI operations
- **Type Safety**: Full TypeScript coverage with strict mode

## License

MIT

## Credits

- **CLIP Model**: OpenAI
- **Transformers.js**: Xenova/HuggingFace
- **UI Design**: Inspired by modern gradient designs
