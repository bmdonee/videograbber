# AGENTS.md

## Project overview
This repository is a lightweight Node.js + Express web app for downloading videos from YouTube, Facebook, TikTok, and Instagram. The app serves a browser UI from the public folder and uses yt-dlp to inspect media and stream downloads.

## Working rules
- Keep the app simple and compatible with the current Express setup.
- Prefer small, targeted edits over broad rewrites.
- Preserve the existing project structure unless a change clearly requires a new file.
- Respect the legal/copyright warning in the README: only download content the user is legally allowed to access.

## Important files
- server.js — Express bootstrap, route registration, and static serving.
- routes/info.js — POST /api/info metadata endpoint.
- routes/download.js — GET /api/download stream/download endpoint.
- utils/ytdlp.js — yt-dlp invocation wrapper, platform detection, format helpers.
- public/index.html — UI entry.
- public/script.js — browser-side fetch logic.
- public/style.css — styling.

## Commands
- Install dependencies: npm install
- Start app: npm start
- Development run (same as start): npm run dev

## Validation
Before considering a fix complete, run at least one targeted verification command relevant to the change. For example:
- Syntax check: node --check server.js
- Syntax check for route/util files: node --check routes/info.js && node --check routes/download.js && node --check utils/ytdlp.js
- Run the app locally after a functional change: npm start

## Architecture notes
- The frontend uses plain HTML, CSS, and JavaScript; avoid introducing a framework unless explicitly requested.
- yt-dlp is expected to be available on the system path, or the app falls back to the bundled youtube-dl-exec binary when present.
- Download requests should remain streaming-safe and handle temporary files carefully.
- Support is intentionally limited to: youtube, facebook, tiktok, instagram.

## Preferred coding style
- Use CommonJS syntax because the project already uses require().
- Keep logging concise and production-safe.
- Validate incoming request data early and return clear errors.
- Preserve semantically named helpers like detectPlatform(), formatDuration(), buildFormats(), and safeFilename().

## When making changes
- Keep API responses consistent with the frontend expectations.
- Maintain `req.query` / `req.body` handling patterns used by existing routes.
- If changing quality or format selection logic, verify both video and audio-only flows still behave correctly.
- If changing platform detection or supported domains, update the relevant route checks and documentation together.

## Repository-specific reminders
- Do not remove the existing legal disclaimer or project mission.
- Do not add hidden or surprising runtime dependencies without a clear reason.
- Keep changes minimal and easy to review.
