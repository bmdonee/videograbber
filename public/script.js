const urlInput = document.getElementById('videoUrl');
const fetchBtn = document.getElementById('fetchBtn');
const errorBox = document.getElementById('errorBox');
const resultBox = document.getElementById('resultBox');

const PLATFORM_PATTERNS = {
  youtube: /(?:youtube\.com|youtu\.be)/i,
  facebook: /(?:facebook\.com|fb\.watch|fb\.com)/i,
  tiktok: /(?:tiktok\.com)/i,
  instagram: /(?:instagram\.com)/i
};

function detectPlatformClient(url) {
  for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
    if (pattern.test(url)) return platform;
  }
  return null;
}

function formatSize(bytes) {
  if (!bytes) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  resultBox.hidden = true;
}

function hideError() {
  errorBox.hidden = true;
}

function setLoading(loading) {
  fetchBtn.disabled = loading;
  fetchBtn.querySelector('.btn-text').hidden = loading;
  fetchBtn.querySelector('.btn-loader').hidden = !loading;
}

function renderResult(data) {
  hideError();
  resultBox.innerHTML = '';

  if (data.thumbnail) {
    const img = document.createElement('img');
    img.src = data.thumbnail;
    img.alt = data.title;
    img.className = 'result-thumb';
    img.onerror = () => { img.style.display = 'none'; };
    resultBox.appendChild(img);
  }

  const title = document.createElement('h3');
  title.className = 'result-title';
  title.textContent = data.title;
  resultBox.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  meta.innerHTML = `
    <span>⏱ ${data.duration}</span>
    <span>👤 ${escapeHtml(data.author)}</span>
    <span>🌐 ${capitalize(data.platform)}</span>
  `;
  resultBox.appendChild(meta);

  const formatsTitle = document.createElement('div');
  formatsTitle.className = 'formats-title';
  formatsTitle.textContent = 'Choose Quality';
  resultBox.appendChild(formatsTitle);

  const list = document.createElement('div');
  list.className = 'formats-list';

  if (!data.formats || data.formats.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No formats available.';
    empty.style.color = 'var(--text-light)';
    list.appendChild(empty);
  } else {
    data.formats.forEach(fmt => {
      const item = document.createElement('div');
      item.className = 'format-item';

      const info = document.createElement('div');
      info.className = 'format-info';
      info.innerHTML = `
        <span class="format-quality">${escapeHtml(fmt.label)}</span>
        <span class="format-size">${formatSize(fmt.filesize)}</span>
      `;

      const btn = document.createElement('button');
      btn.className = 'btn-download';
      btn.textContent = 'Download';
      btn.addEventListener('click', () => startDownload(data.webpage_url, fmt, data.title));

      item.appendChild(info);
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  resultBox.appendChild(list);

  // Ad placeholder below download card (disabled)
  // const adSlot = document.createElement('div');
  // adSlot.className = 'ad-result ad-placeholder';
  // adSlot.textContent = 'Ad Space (responsive)';
  // resultBox.appendChild(adSlot);

  resultBox.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const PHASE_TITLES = {
  starting: 'Starting your download',
  fetching: 'Reading video details',
  downloading: 'Downloading your video',
  processing: 'Preparing your file',
  sending: 'Finishing up',
  done: 'Download complete',
  error: 'Download failed'
};

let progressSource = null;
let progressHideTimer = null;
let downloadInProgress = false;

const progressOverlay = document.getElementById('progressOverlay');
const progressBar = document.getElementById('progressBar');
const progressPercent = document.getElementById('progressPercent');
const progressTitle = document.getElementById('progressTitle');
const progressDetail = document.getElementById('progressDetail');

function setProgressBar(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent || 0)));
  progressBar.classList.toggle('is-indeterminate', value <= 1);
  progressBar.style.width = value + '%';
  progressPercent.textContent = value + '%';
}

function openProgress(title, detail) {
  clearTimeout(progressHideTimer);
  progressOverlay.classList.remove('is-done', 'is-error');
  progressOverlay.hidden = false;
  progressTitle.textContent = PHASE_TITLES.starting;
  progressDetail.textContent = title || 'Please wait...';
  setProgressBar(0);
}

function closeProgress(phase, message) {
  const failed = phase === 'error';
  progressOverlay.classList.toggle('is-error', failed);
  progressOverlay.classList.toggle('is-done', !failed);
  progressTitle.textContent = PHASE_TITLES[phase] || PHASE_TITLES.done;
  progressDetail.textContent = message || '';
  progressDetail.removeAttribute('title');
  if (message) progressDetail.title = message;
  setProgressBar(failed ? 0 : 100);
  progressBar.classList.remove('is-indeterminate');
  downloadInProgress = false;

  if (failed) showError(message);

  clearTimeout(progressHideTimer);
  progressHideTimer = setTimeout(() => {
    progressOverlay.hidden = true;
  }, failed ? 7000 : 2500);
}

function closeProgressStream() {
  if (progressSource) {
    progressSource.close();
    progressSource = null;
  }
}

function createJobId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'job' + Date.now() + Math.random().toString(36).slice(2, 10);
}

function watchProgress(jobId) {
  closeProgressStream();

  let source;
  try {
    source = new EventSource('/api/download/status/' + encodeURIComponent(jobId));
  } catch (e) {
    return;
  }
  progressSource = source;

  source.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    if (data.phase === 'done' || data.phase === 'error') {
      closeProgressStream();
      closeProgress(data.phase, data.message);
      return;
    }

    if (PHASE_TITLES[data.phase]) progressTitle.textContent = PHASE_TITLES[data.phase];
    if (data.message) {
      progressDetail.textContent = data.message;
      progressDetail.title = data.message;
    }
    if (typeof data.percent === 'number') setProgressBar(data.percent);
  };

  source.onerror = () => {
    closeProgressStream();
    // The stream drops once the server finishes, so only treat this as a
    // failure if we never reached a final state.
    if (!progressOverlay.hidden && !progressOverlay.classList.contains('is-done')
        && !progressOverlay.classList.contains('is-error')) {
      closeProgress('error', 'Lost connection to the download server. Please try again.');
    }
  };
}

function startDownload(url, format, title) {
  if (downloadInProgress) {
    showError('A download is already in progress. Please wait for it to finish.');
    return;
  }

  const params = new URLSearchParams({ url });
  if (title) params.append('title', title);
  if (format.ext === 'mp3' || format.id === 'bestaudio') {
    params.append('format', 'mp3');
  } else {
    const qualityNum = format.quality.replace('p', '');
    params.append('quality', qualityNum);
  }

  const jobId = createJobId();
  params.append('jobId', jobId);

  downloadInProgress = true;
  openProgress(title);
  watchProgress(jobId);

  const link = document.createElement('a');
  link.href = '/api/download?' + params.toString();
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !progressOverlay.hidden) {
    closeProgressStream();
    progressOverlay.hidden = true;
    downloadInProgress = false;
  }
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function handleFetch() {
  const url = urlInput.value.trim();

  if (!url) {
    showError('Please paste a video URL first.');
    return;
  }

  const platform = detectPlatformClient(url);
  if (!platform) {
    showError('Unsupported URL. Please use a YouTube, Facebook, TikTok, or Instagram link.');
    return;
  }

  setLoading(true);
  hideError();
  resultBox.hidden = true;

  try {
    const response = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch video information');
    }

    renderResult(data);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

fetchBtn.addEventListener('click', handleFetch);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleFetch();
});

document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  });
});

/* Theme toggle + responsive navigation.
   Light is the default; dark is applied only once the user opts in and the
   choice is remembered in localStorage (re-applied before paint by the inline
   script in the document head). */
(function () {
  const root = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  const navToggle = document.getElementById('navToggle');
  const nav = document.getElementById('siteNav');
  const STORAGE_KEY = 'vg-theme';
  const MOBILE_BREAKPOINT = 768;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const isDark = () => root.getAttribute('data-theme') === 'dark';

  function syncToggle() {
    if (!themeToggle) return;
    const dark = isDark();
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    themeToggle.setAttribute('aria-pressed', String(dark));
    themeToggle.setAttribute('aria-label', label);
    themeToggle.setAttribute('title', label);
  }

  function applyTheme(theme) {
    if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
    }
    syncToggle();
  }

  function toggleTheme() {
    const next = isDark() ? 'light' : 'dark';

    if (reduceMotion) {
      applyTheme(next);
    } else {
      root.classList.add('theme-transition');
      applyTheme(next);
      window.setTimeout(() => root.classList.remove('theme-transition'), 300);
    }

    try {
      if (next === 'dark') {
        localStorage.setItem(STORAGE_KEY, 'dark');
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (err) {
      /* storage unavailable (private mode) - theme still applies for this page */
    }
  }

  function setMenu(open) {
    if (!navToggle || !nav) return;
    nav.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  syncToggle();

  if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme);
  }

  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      setMenu(navToggle.getAttribute('aria-expanded') !== 'true');
    });

    // Following a link should dismiss the panel it was opened from.
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) setMenu(false);
    });

    document.addEventListener('click', (e) => {
      if (!nav.classList.contains('is-open')) return;
      if (e.target.closest('.header')) return;
      setMenu(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !nav.classList.contains('is-open')) return;
      setMenu(false);
      navToggle.focus();
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > MOBILE_BREAKPOINT) setMenu(false);
    });
  }
})();
