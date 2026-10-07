const express = require('express');
const router = express.Router();
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { detectPlatform, ytdlpPath, ffmpegLocation, ffmpegPath, ffprobePath, hasFfmpeg, hasFfprobe, resolveCookiesFile } = require('../utils/ytdlp');
const progress = require('../utils/progress');

const SUPPORTED = ['youtube', 'facebook', 'tiktok', 'instagram'];

/**
 * Streams download progress to the browser over Server-Sent Events so the UI
 * can show a real progress bar instead of an indefinite spinner.
 */
router.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;

  if (!progress.isValidJobId(jobId)) {
    return res.status(400).json({ error: 'Invalid job id' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = job => {
    res.write(`data: ${JSON.stringify(job)}\n\n`);
  };

  const current = progress.get(jobId);
  if (current) send(current);

  const unsubscribe = progress.on(jobId, send);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

/**
 * Keeps the real title readable: spaces, accents, Arabic and emoji all
 * survive. Only characters that are illegal in filenames or HTTP headers
 * are replaced.
 */
function cleanTitle(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
}

/**
 * Caps by UTF-8 bytes, not characters, so Arabic/emoji titles cannot push the
 * name past the 255-byte filename limit.
 */
function truncate(text, maxBytes = 180) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out.replace(/[.\s]+$/, '');
}

/**
 * Variant written to disk by yt-dlp. "%" is escaped because the output
 * template treats "%(ext)s" as a placeholder.
 */
function safeFilename(name) {
  const cleaned = cleanTitle(name).replace(/%/g, '_');
  return truncate(cleaned) || 'video';
}

/**
 * Node rejects non-latin1 header values, so non-ASCII titles (Arabic, emoji)
 * need the RFC 5987 filename* form alongside an ASCII fallback.
 */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function safeQuality(value) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.min(num, 4320);
}

/**
 * Prefers H.264 + AAC inside MP4 because AV1/VP9 + Opus muxed into MP4 is
 * rejected by QuickTime, Windows Media Player and many mobile players.
 */
function buildVideoFormat(quality) {
  const cap = quality ? `height<=${quality}` : '';
  const parts = quality
    ? [
        `bestvideo[${cap}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]`,
        `best[${cap}][ext=mp4]`,
        `bestvideo[${cap}]+bestaudio`,
        `best[${cap}]`
      ]
    : [
        'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]',
        'best[ext=mp4]',
        'bestvideo+bestaudio',
        'best'
      ];
  return parts.join('/');
}

/**
 * Returns the finished file, or null when yt-dlp left several unmerged
 * streams behind (which means merging failed).
 */
function resolveOutputFile(tmpDir, baseName, expectedExt) {
  const exact = path.join(tmpDir, `${baseName}.${expectedExt}`);
  if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact;

  const entries = fs
    .readdirSync(tmpDir)
    .filter(f => f.startsWith(`${baseName}.`) && fs.statSync(path.join(tmpDir, f)).isFile());

  if (entries.length === 1) return path.join(tmpDir, entries[0]);
  return null;
}

/**
 * Facebook/Instagram/TikTok only publish AV1 or VP9 streams. Muxed into MP4
 * they decode in VLC but play as audio-only in QuickTime, Windows Media Player
 * and most phone players, so anything that is not H.264 gets re-encoded.
 */
function isH264(codec) {
  return codec === 'h264' || codec === 'avc1';
}

function probeVideoCodec(filePath) {
  const result = spawnSync(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'csv=p=0',
    filePath
  ], { encoding: 'utf8' });

  if (result.status !== 0) return null;
  const codec = (result.stdout || '').trim().split(/\r?\n/)[0];
  return codec || null;
}

function transcodeToH264(inputPath) {
  const outputPath = inputPath.replace(/\.[^.]+$/, '') + '.h264.mp4';
  console.log('Transcoding', inputPath, 'to H.264');
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ], { encoding: 'utf8' });

  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    console.error('H.264 transcode failed:', result.stderr);
    return null;
  }
  return outputPath;
}

router.get('/', async (req, res) => {
  try {
    const { url, format, quality, title, jobId } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const job = progress.isValidJobId(jobId) ? jobId : null;
    if (job) progress.update(job, { phase: 'starting', percent: 0, message: 'Preparing your download...', legs: 0 });

    const platform = detectPlatform(url);
    if (platform === 'unknown' || !SUPPORTED.includes(platform)) {
      return res.status(400).json({ error: 'Unsupported platform' });
    }

    const baseName = safeFilename(title);
    const isAudio = format === 'mp3' || quality === 'audio';
    const ext = isAudio ? 'mp3' : 'mp4';
    const filename = `${truncate(cleanTitle(title)) || 'video'}.${ext}`;

    if (isAudio && !hasFfmpeg) {
      return res.status(500).json({ error: 'MP3 conversion is unavailable because ffmpeg was not found on this server.' });
    }

    let formatOption;
    if (isAudio) {
      formatOption = 'bestaudio/best';
    } else {
      const cap = safeQuality(quality);
      if (hasFfmpeg) {
        formatOption = buildVideoFormat(cap);
      } else {
        // Without ffmpeg nothing can be merged, so ask for a single
        // self-contained stream instead of downloading two broken halves.
        formatOption = cap ? `best[height<=${cap}][ext=mp4]/best[height<=${cap}]` : 'best[ext=mp4]/best';
      }
    }

    const tmpDir = path.join(os.tmpdir(), 'ytdl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(tmpDir, { recursive: true });
    const outPath = path.join(tmpDir, `${baseName}.%(ext)s`);

    const args = [
      url,
      '--format', formatOption,
      '--output', outPath,
      '--merge-output-format', 'mp4',
      '--no-check-certificates',
      '--no-warnings',
      '--no-part',
      '--no-mtime',
      '--newline'
    ];

    if (!isAudio) {
      args.push('--remux-video', 'mp4');
    }

    if (ffmpegLocation) {
      args.push('--ffmpeg-location', ffmpegLocation);
    }

    if (platform === 'youtube') {
      args.push('--extractor-args', 'youtube:player_client=android,web');
    }
    const cookiesFile = resolveCookiesFile();
    if (cookiesFile) {
      args.push('--cookies', cookiesFile);
    }

    if (isAudio) {
      args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
    }

    // A "+" selector means yt-dlp fetches separate video and audio streams,
    // each with its own 0-100% counter.
    if (job) {
      progress.update(job, {
        phase: 'fetching',
        percent: 1,
        totalLegs: formatOption.includes('+') ? 2 : 1,
        message: 'Fetching video information...'
      });
    }

    res.setHeader('Content-Disposition', contentDisposition(filename));
    if (isAudio) {
      res.setHeader('Content-Type', 'audio/mpeg');
    } else {
      res.setHeader('Content-Type', 'video/mp4');
    }

    const ytdlp = spawn(ytdlpPath, args, {
      windowsHide: true,
      shell: false
    });

    let stderrLog = '';
    ytdlp.stderr.on('data', (data) => {
      const text = data.toString();
      stderrLog += text;
      console.error('yt-dlp stderr:', text);
    });

    let stdoutBuf = '';
    ytdlp.stdout.on('data', (chunk) => {
      if (!job) return;
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n|\r/);
      stdoutBuf = lines.pop();
      for (const line of lines) progress.handleLine(job, line);
    });

    // yt-dlp explains the real reason (private video, unavailable, geo-block,
    // sign-in required) so pass that through instead of a blanket failure.
    function upstreamError() {
      const line = stderrLog
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.startsWith('ERROR:'))
        .pop();
      if (!line) return 'Download failed';
      return line
        .replace(/^ERROR:\s*/, '')
        .replace(/^\[[^\]]+\]\s*/, '')
        .slice(0, 300);
    }

    ytdlp.on('error', (err) => {
      console.error('yt-dlp error:', err);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      progress.update(job, { phase: 'error', percent: 0, message: 'Download failed' });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed' });
      } else {
        res.end();
      }
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        console.error('yt-dlp exited with code', code);
        const message = upstreamError();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        progress.update(job, { phase: 'error', percent: 0, message });
        if (!res.headersSent) {
          res.status(500).json({ error: message });
        } else {
          res.end();
        }
        return;
      }

      const finalExt = isAudio ? 'mp3' : 'mp4';
      let finalPath = resolveOutputFile(tmpDir, baseName, finalExt);

      if (!finalPath) {
        const leftovers = fs.readdirSync(tmpDir).filter(f => f.startsWith(`${baseName}.`));
        console.error('yt-dlp produced no usable output. Files:', leftovers);
        const message = leftovers.length > 1
          ? 'Could not merge video and audio. ffmpeg/ffprobe are required to combine the streams.'
          : 'Download produced no output file.';
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        progress.update(job, { phase: 'error', percent: 0, message });
        if (!res.headersSent) {
          res.status(500).json({ error: message });
        } else {
          res.end();
        }
        return;
      }

      if (!isAudio && hasFfprobe) {
        const codec = probeVideoCodec(finalPath);
        if (!codec) {
          // Never hand back an audio-only file pretending to be a video.
          console.error('Output contains no video stream:', finalPath);
          const message = 'The source returned an audio-only stream, so no video could be produced.';
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
          progress.update(job, { phase: 'error', percent: 0, message });
          if (!res.headersSent) {
            res.status(500).json({ error: message });
          } else {
            res.end();
          }
          return;
        }
        if (!isH264(codec) && hasFfmpeg) {
          progress.update(job, { phase: 'processing', percent: 88, message: 'Converting to H.264 for maximum compatibility...' });
          const converted = transcodeToH264(finalPath);
          if (converted) {
            try { fs.unlinkSync(finalPath); } catch (e) {}
            finalPath = converted;
          }
        }
      }

      const stat = fs.statSync(finalPath);
      res.setHeader('Content-Length', stat.size);
      progress.update(job, { phase: 'sending', percent: 95, message: 'Sending file to your device...' });

      const stream = fs.createReadStream(finalPath);
      let sent = 0;
      let lastSentPercent = -1;
      stream.on('data', (chunk) => {
        sent += chunk.length;
        const ratio = stat.size ? Math.round((sent / stat.size) * 100) : 100;
        const overall = 95 + Math.floor(ratio * 0.05);
        if (overall !== lastSentPercent) {
          lastSentPercent = overall;
          progress.update(job, { phase: 'sending', percent: overall, message: `Sending file to your device - ${ratio}%` });
        }
      });

      stream.pipe(res);
      res.on('finish', () => {
        progress.update(job, { phase: 'done', percent: 100, message: 'Download complete!' });
      });
      res.on('close', () => {
        progress.update(job, { phase: 'done', percent: 100, message: 'Download complete!' });
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      });
    });

    req.on('close', () => {
      try { ytdlp.kill(); } catch (e) {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    });

  } catch (error) {
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Download failed' });
    }
  }
});

module.exports = router;
