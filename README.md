# TopPics

AI-powered Chrome extension to find and delete duplicate photos from Google Photos.

## Features

- 📸 **Scan Google Photos**: Extract photos directly from your Google Photos library
- 🔍 **AI-Powered Indexing**: Uses DINOv2 embeddings to identify similar photos
- 👥 **Smart Grouping**: Groups duplicates based on visual similarity and time taken
- 🎯 **Auto-Select (Paid Feature)**: AI automatically selects the best photos to keep
- 🗑️ **Bulk Delete**: Create albums in Google Photos for easy deletion

## Architecture

### Frontend (Chrome Extension)
- **Tech Stack**: Svelte + TypeScript + TailwindCSS
- **Storage**: IndexedDB for photos, embeddings, and groups
- **AI Processing**: Client-side with Transformers.js (DINOv2)
- **Location**: `chrome-extensions/`

### Backend (Auto-Select API)
- **Tech Stack**: Python + FastAPI + SQLite
- **AI Integration**: Google Gemini 2.0 Flash (batch processing)
- **Location**: `backend/`

## Setup

### Chrome Extension

1. Install dependencies:
```bash
cd chrome-extensions
npm install
```

2. Build the extension:
```bash
npm run build
```

3. Load in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `chrome-extensions/build` directory

### Backend (Optional - for Auto-Select feature)

1. Create virtual environment:
```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Configure environment:
```bash
cp .env.example .env
# Edit .env and add your GOOGLE_API_KEY
```

4. Run the server:
```bash
python main.py
```

The API will be available at `http://localhost:8000`

### Frontend Configuration for Auto-Select

Create a `.env` file in the `chrome-extensions/` directory:

```env
VITE_API_BASE_URL=http://localhost:8000
```

## Usage

### Basic Flow (Free)

1. **Scan Photos**
   - Click extension icon
   - Navigate to Google Photos
   - Extension will automatically scan your photos

2. **Index Photos**
   - Click "Start Indexing" to calculate AI embeddings
   - This runs locally in your browser

3. **Group Duplicates**
   - Adjust similarity threshold and time window in settings
   - Click "Start Grouping" to find duplicates

4. **Review & Delete**
   - Browse duplicate groups
   - Manually select photos to delete
   - Click "Delete from Google Photos" to create deletion album

### Auto-Select Flow (Paid)

1. Complete basic flow steps 1-3
2. Click "Auto Select" button
3. Review pricing and enter email
4. Complete mock payment
5. Photos are uploaded to backend
6. Wait for AI processing (few hours)
7. Review AI suggestions with detailed reasons
8. Delete selected photos

## Auto-Select Feature Details

### How It Works

1. **Upload**: Your grouped photos are securely uploaded to the backend
2. **AI Analysis**: Google Gemini AI analyzes each group using:
   - Duplicate detection
   - Quality assessment (blur, exposure, composition)
   - Artistic merit evaluation
   - Emotional value preservation
3. **Smart Selection**: AI suggests which photos to delete with detailed reasons
4. **Your Control**: Review suggestions and adjust before deletion

### Pricing

- **$0.01 per photo** analyzed
- Example: 1,000 photos = $10.00
- One-time payment per analysis

### Privacy & Security

- Photos are processed and then deleted from backend storage
- Processing happens via Google's secure Gemini API
- Results are stored only in your browser's IndexedDB

## Development

### Frontend Development

```bash
cd chrome-extensions
npm run dev
```

### Backend Development

```bash
cd backend

# Format code
black main.py gemini_processor.py

# Lint code
ruff check main.py gemini_processor.py

# Run with auto-reload
uvicorn main:app --reload
```

## API Documentation

When the backend is running, visit:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

### Key Endpoints

- `POST /v1/api/checkout` - Create payment session
- `GET /v1/api/checkout/:id` - Mock checkout page
- `POST /v1/api/job/:id/upload` - Upload photos
- `POST /v1/api/job/:id` - Start AI processing
- `GET /v1/api/job/:id` - Poll for results (202 = processing, 200 = complete)

## Technology Stack

### Frontend
- Svelte 5
- TypeScript
- TailwindCSS
- IndexedDB (Dexie.js)
- Transformers.js (DINOv2)

### Backend
- FastAPI
- SQLite with aiosqlite
- Google Gemini 2.0 Flash
- Black + Ruff (linting)

## Project Structure

```
top-pics/
├── chrome-extensions/          # Chrome extension
│   ├── src/
│   │   ├── components/        # Svelte components
│   │   ├── lib/              # Utilities (db, embeddings, grouping, api)
│   │   ├── stores/           # State management
│   │   └── App.svelte        # Main app
│   ├── public/               # Static assets
│   └── package.json
│
├── backend/                   # Python backend API
│   ├── main.py              # FastAPI app
│   ├── gemini_processor.py  # AI integration
│   ├── requirements.txt     # Dependencies
│   ├── uploads/             # Temporary photo storage
│   └── README.md
│
└── README.md                 # This file
```

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run linters (frontend: `npm run lint`, backend: `ruff check`)
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues or questions:
- GitHub Issues: [Create an issue]
- Email: support@tallisa.dev

## Roadmap

- [ ] Real payment integration (Stripe)
- [ ] Background sync for Google Photos
- [ ] Advanced filtering options
- [ ] Export analysis reports
- [ ] Batch job queue management
- [ ] Support for other photo services

## Credits

- AI Model: Facebook DINOv2 (client-side)
- AI Analysis: Google Gemini 2.0 Flash (backend)
- UI Framework: Svelte
- Design: Soft Brutalism aesthetic
