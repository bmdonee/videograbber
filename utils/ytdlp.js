const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

function isExecutable(candidate) {
  if (!candidate || !candidate.trim()) return false;
  if (candidate.includes('/') || candidate.includes('\\')) {
    return fs.existsSync(candidate);
  }
  const test = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return test.status === 0;
}

function isRunnableFile(candidate) {
  if (!candidate || !candidate.trim()) return false;
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function resolveYtdlpPath() {
  const userHome = process.env.USERPROFILE || process.env.HOME;
  const isWin = process.platform === 'win32';
  const customPath = path.join(userHome, isWin ? 'yt-dlp.exe' : 'yt-dlp');
  const fallbackPath = path.join(__dirname, '..', 'node_modules', 'youtube-dl-exec', 'bin', isWin ? 'yt-dlp.exe' : 'yt-dlp');

  for (const candidate of [customPath, fallbackPath]) {
    if (isExecutable(candidate)) return candidate;
  }

  const which = spawnSync(isWin ? 'where' : 'which', ['yt-dlp'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout) {
    const fromPath = which.stdout.trim().split(/\r?\n/)[0];
    if (isExecutable(fromPath)) return fromPath;
  }

  if (isExecutable('yt-dlp')) return 'yt-dlp';

  return customPath;
}

const ytdlpPath = resolveYtdlpPath();

function whichBin(name) {
  const isWin = process.platform === 'win32';
  const res = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return null;
  const first = res.stdout.trim().split(/\r?\n/)[0];
  return isRunnableFile(first) ? first : null;
}

function linkOrCopy(target, source) {
  try {
    if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) fs.rmSync(target, { force: true });
  } catch (e) {}
  try {
    fs.symlinkSync(source, target);
  } catch (e) {
    fs.copyFileSync(source, target);
  }
}

/**
 * yt-dlp needs BOTH ffmpeg and ffprobe, and it looks for both inside the same
 * directory. ffmpeg-static and ffprobe-static ship into different folders, so we
 * expose them through one shared folder of links.
 */
function resolveFfmpeg() {
  let ffmpeg = null;
  let ffprobe = null;

  try {
    const bundled = require('ffmpeg-static');
    if (isRunnableFile(bundled)) ffmpeg = bundled;
  } catch (e) {}

  try {
    const bundled = require('ffprobe-static').path;
    if (isRunnableFile(bundled)) ffprobe = bundled;
  } catch (e) {}

  if (!ffmpeg) ffmpeg = whichBin('ffmpeg');
  if (!ffprobe) {
    ffprobe = whichBin('ffprobe');
    if (!ffprobe && ffmpeg) {
      const sibling = path.join(path.dirname(ffmpeg), 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''));
      if (isRunnableFile(sibling)) ffprobe = sibling;
    }
  }

  if (!ffmpeg) return { ffmpeg: null, ffprobe: null, location: null };

  const ffmpegDir = path.dirname(ffmpeg);
  if (ffprobe && path.dirname(ffprobe) === ffmpegDir) {
    return { ffmpeg, ffprobe, location: ffmpegDir };
  }

  const ext = process.platform === 'win32' ? '.exe' : '';
  const linkDir = path.join(os.tmpdir(), 'ytdl-ffmpeg-bin');
  try {
    fs.mkdirSync(linkDir, { recursive: true });
    linkOrCopy(path.join(linkDir, 'ffmpeg' + ext), ffmpeg);
    if (ffprobe) linkOrCopy(path.join(linkDir, 'ffprobe' + ext), ffprobe);
    return { ffmpeg, ffprobe, location: linkDir };
  } catch (e) {
    return { ffmpeg, ffprobe, location: ffmpegDir };
  }
}

const ffmpeg = resolveFfmpeg();
const ffmpegLocation = ffmpeg.location;
const ffmpegPath = ffmpeg.ffmpeg;
const ffprobePath = ffmpeg.ffprobe;
const hasFfmpeg = Boolean(ffmpeg.ffmpeg);
const hasFfprobe = Boolean(ffmpeg.ffprobe);

function runYtdlp(url, flags) {
  return new Promise((resolve, reject) => {
    const args = [url, ...flags];
    const child = spawn(ytdlpPath, args, {
      windowsHide: true,
      shell: false
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('error', (err) => reject(err));
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve(stdout);
        }
      } else {
        const err = new Error(stderr.trim() || `yt-dlp exited with code ${exitCode}`);
        err.stderr = stderr;
        err.stdout = stdout;
        err.exitCode = exitCode;
        reject(err);
      }
    });
  });
}

function toKebab(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function buildFlags(flagsObj) {
  const args = [];
  for (const [key, value] of Object.entries(flagsObj)) {
    const flag = `--${toKebab(key)}`;
    if (value === true) {
      args.push(flag);
    } else if (Array.isArray(value)) {
      value.forEach(v => args.push(flag, String(v)));
    } else if (value !== false && value != null) {
      args.push(flag, String(value));
    }
  }
  return args;
}

let cachedCookiesFile = null;

/**
 * Optional YouTube authentication. Datacenter IPs (Render, Railway, etc.)
 * are frequently hit by YouTube's "Sign in to confirm you're not a bot"
 * check. Exporting a cookies.txt from a logged-in browser and providing it
 * via the YOUTUBE_COOKIES env var (full file content) or a cookies.txt file
 * lets yt-dlp look like a signed-in viewer. Without it, YouTube may fail
 * while TikTok/Instagram/Facebook keep working.
 */
function resolveCookiesFile() {
  if (cachedCookiesFile && fs.existsSync(cachedCookiesFile)) return cachedCookiesFile;

  const fromEnv = process.env.YOUTUBE_COOKIES;
  if (fromEnv && fromEnv.includes('youtube.com')) {
    const target = path.join(os.tmpdir(), 'yt-cookies.txt');
    try {
      fs.writeFileSync(target, fromEnv.replace(/\\n/g, '\n'));
      cachedCookiesFile = target;
      return target;
    } catch (e) {}
  }

  const candidates = [
    process.env.COOKIES_FILE,
    path.join(__dirname, '..', 'cookies.txt'),
    '/etc/secrets/cookies.txt'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {}
  }
  return null;
}

async function getVideoInfo(url) {
  try {
    const flagObj = {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      // The old addHeader cookie is deprecated by yt-dlp; the android player
      // client works without login for most public videos.
      extractorArgs: 'youtube:player_client=android,web'
    };
    const cookies = resolveCookiesFile();
    if (cookies) flagObj.cookies = cookies;
    const flags = buildFlags(flagObj);
    return await runYtdlp(url, flags);
  } catch (error) {
    throw new Error(`Failed to fetch video info: ${error.message}`);
  }
}

function detectPlatform(url) {
  if (/(?:youtube\.com|youtu\.be)/i.test(url)) return 'youtube';
  if (/(?:facebook\.com|fb\.watch|fb\.com)/i.test(url)) return 'facebook';
  if (/(?:tiktok\.com)/i.test(url)) return 'tiktok';
  if (/(?:instagram\.com)/i.test(url)) return 'instagram';
  return 'unknown';
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function compareFormats(a, b) {
  const rank = f => {
    const vcodec = typeof f.vcodec === 'string' ? f.vcodec : '';
    let score = 0;
    if (f.protocol === 'https') score += 3;
    if (vcodec.startsWith('avc1')) score += 4;
    else if (vcodec.startsWith('av01')) score += 1;
    if (f.ext === 'mp4') score += 1;
    return score;
  };
  const diff = rank(a) - rank(b);
  if (diff !== 0) return diff;
  return (a.tbr || 0) - (b.tbr || 0);
}

function buildFormats(info) {
  const formats = [];
  const seen = new Set();

  if (info.formats && Array.isArray(info.formats)) {
    const videoFormats = info.formats.filter(f =>
      f.vcodec && f.vcodec !== 'none' && f.height && f.height >= 144
    );

    const grouped = {};
    videoFormats.forEach(f => {
      const key = f.height;
      if (!grouped[key] || compareFormats(f, grouped[key]) > 0) {
        grouped[key] = f;
      }
    });

    const duration = info.duration || 0;

    Object.values(grouped).forEach(f => {
      const key = `${f.height}p`;
      if (!seen.has(key)) {
        seen.add(key);
        let filesize = f.filesize || f.filesize_approx || null;
        if (!filesize && f.tbr && duration) {
          filesize = Math.round((f.tbr * 1000 / 8) * duration);
        }
        formats.push({
          id: f.format_id,
          quality: key,
          ext: 'mp4',
          label: `MP4 - ${key}`,
          filesize
        });
      }
    });

    formats.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
  }

  const audioFormat = info.formats && info.formats.find(f =>
    f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
  );
  let audioSize = null;
  if (audioFormat) {
    audioSize = audioFormat.filesize || audioFormat.filesize_approx || null;
    if (!audioSize && audioFormat.abr && info.duration) {
      audioSize = Math.round((audioFormat.abr * 1000 / 8) * info.duration);
    }
  }

  formats.push({
    id: 'bestaudio',
    quality: 'audio',
    ext: 'mp3',
    label: 'MP3 - Audio Only',
    filesize: audioSize
  });

  return formats;
}

function buildDownloadFlags(formatOption) {
  return buildFlags({
    format: formatOption,
    output: '-',
    mergeOutputFormat: 'mp4',
    noCheckCertificates: true,
    noWarnings: true
  });
}

module.exports = {
  getVideoInfo,
  resolveCookiesFile,
  detectPlatform,
  formatDuration,
  buildFormats,
  buildDownloadFlags,
  ytdlpPath,
  ffmpegLocation,
  ffmpegPath,
  ffprobePath,
  hasFfmpeg,
  hasFfprobe
};
