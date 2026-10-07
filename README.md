# VideoGrabber

A free, fast, and easy-to-use video downloader web app that lets users save videos and reels from YouTube, Facebook, TikTok, and Instagram in HD quality.

## Features

- Download from **YouTube**, **Facebook**, **TikTok**, and **Instagram**
- Multiple quality options (up to 1080p) + audio-only (MP3)
- TikTok videos without watermark
- No registration required
- Mobile-friendly responsive design
- Rate-limited API to prevent abuse
- Ad placeholders ready for monetization

## Tech Stack

- **Backend:** Node.js + Express
- **Downloader:** yt-dlp (via `youtube-dl-exec` npm package)
- **Frontend:** Plain HTML + CSS + JavaScript
- **Security:** CORS, rate limiting (100 req / 15 min)

## Project Structure

```
.
├── server.js              # Express server entry point
├── package.json
├── .gitignore
├── public/
│   ├── index.html         # Main page
│   ├── style.css          # Styling
│   └── script.js          # Frontend logic
├── routes/
│   ├── info.js            # POST /api/info
│   └── download.js        # GET /api/download
├── utils/
│   └── ytdlp.js           # yt-dlp wrapper & helpers
└── README.md
```

## Prerequisites

1. **Node.js** v18 or higher — [Download](https://nodejs.org)
2. **yt-dlp** binary installed on your system:
   - Windows: `winget install yt-dlp` or download from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases)
   - macOS: `brew install yt-dlp`
   - Linux: `sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp`
3. **ffmpeg** (optional, for format merging):
   - Windows: `winget install ffmpeg`
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`

## Installation

```bash
# 1. Install dependencies
npm install

# 2. Verify yt-dlp is installed
yt-dlp --version

# 3. Start the server
npm start
```

The server runs on `http://localhost:3000`.

## Usage

1. Open `http://localhost:3000` in your browser
2. Paste a video URL (YouTube, Facebook, TikTok, or Instagram)
3. Click **Get Video**
4. Choose a quality and click **Download**

## API Reference

### `POST /api/info`

Fetches video metadata.

**Request body:**
```json
{ "url": "https://www.youtube.com/watch?v=..." }
```

**Response:**
```json
{
  "platform": "youtube",
  "title": "Video title",
  "thumbnail": "https://...",
  "duration": "10:35",
  "durationSeconds": 635,
  "author": "Channel name",
  "uploaderUrl": "https://...",
  "webpage_url": "https://...",
  "formats": [
    { "id": "...", "quality": "1080p", "ext": "mp4", "label": "MP4 - 1080p", "filesize": 12345678 },
    { "id": "bestaudio", "quality": "audio", "ext": "mp3", "label": "MP3 - Audio Only", "filesize": null }
  ]
}
```

### `GET /api/download?url=...&quality=720p`

Streams the video file directly to the browser. Optional `format=mp3` for audio-only.

## Legal Disclaimer

This tool is provided for downloading videos you have the right to download. Respect copyright laws and the rights of content creators. VideoGrabber is not affiliated with YouTube, Facebook, TikTok, or Instagram.

## License

MIT
