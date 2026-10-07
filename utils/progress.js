const { EventEmitter } = require('events');

const jobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function isValidJobId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function ensureJob(id) {
  let job = jobs.get(id);
  if (!job) {
    job = {
      phase: 'starting',
      percent: 0,
      message: 'Preparing your download...',
      legs: 0,
      totalLegs: 1,
      updatedAt: Date.now()
    };
    jobs.set(id, job);
  }
  return job;
}

function update(id, patch) {
  if (!isValidJobId(id)) return null;
  const job = ensureJob(id);
  Object.assign(job, patch, { updatedAt: Date.now() });
  emitter.emit(id, job);
  return job;
}

function get(id) {
  if (!isValidJobId(id)) return null;
  return jobs.get(id) || null;
}

function on(id, listener) {
  emitter.on(id, listener);
  return () => emitter.off(id, listener);
}

const DOWNLOAD_RE = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+)\s*(B|KiB|MiB|GiB)/i;
const DEST_RE = /\[download\]\s+Destination:/i;
const PROCESS_RE = /\[(Merger|ExtractAudio|VideoRemuxer|Metadata|Fixup\w*|Remuxer)\]/i;
const FETCH_RE = /Downloading\s+(webpage|json|api|m3u8|player|.*information|.*formats|.*manifest)/i;

const UNITS = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3 };

function toBytes(value, unit) {
  return Math.round(value * (UNITS[unit.toUpperCase()] || 1));
}

function scale(percent, from, to) {
  const clamped = Math.max(0, Math.min(100, percent));
  return Math.max(from, Math.min(to, Math.round(from + (clamped / 100) * (to - from))));
}

/**
 * yt-dlp prints one progress line per stream, and each stream restarts at 0%,
 * so the overall bar is derived from how many streams we expect to fetch.
 */
function handleLine(id, line) {
  if (!isValidJobId(id) || !line) return;

  const percent = line.match(DOWNLOAD_RE);
  if (percent) {
    const job = ensureJob(id);
    const value = parseFloat(percent[1]);
    const done = (((Math.max(job.legs, 1) - 1) + value / 100) / job.totalLegs) * 100;
    update(id, {
      phase: 'downloading',
      percent: scale(done, 5, 80),
      totalBytes: toBytes(parseFloat(percent[2]), percent[3]),
      message: `Downloading video data - ${value.toFixed(0)}%`
    });
    return;
  }

  if (DEST_RE.test(line)) {
    const job = ensureJob(id);
    job.legs = Math.min(job.legs + 1, job.totalLegs);
    update(id, {
      phase: 'downloading',
      percent: scale(((job.legs - 1) / job.totalLegs) * 100, 5, 80),
      message: 'Starting download...'
    });
    return;
  }

  if (PROCESS_RE.test(line)) {
    const job = ensureJob(id);
    update(id, {
      phase: 'processing',
      percent: Math.max(job.percent, 82),
      message: 'Converting and merging video + audio...'
    });
    return;
  }

  if (FETCH_RE.test(line)) {
    const job = ensureJob(id);
    update(id, {
      phase: 'fetching',
      percent: Math.min(job.percent, 3),
      message: 'Fetching video information...'
    });
  }
}

const sweep = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) {
      jobs.delete(id);
      emitter.removeAllListeners(id);
    }
  }
}, 60 * 1000);
sweep.unref();

module.exports = { isValidJobId, ensureJob, update, get, on, handleLine };