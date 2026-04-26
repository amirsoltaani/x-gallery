// Captures media from tweets as they appear and shows them in a grid overlay.

const collected = new Map(); // tweetId -> { images: [], videoPoster, link, author }
const rendered = new Set();  // tweetIds already in the grid
const activeHls = new Map(); // videoElement -> Hls instance
let galleryOpen = false;
let galleryEl = null;
let videoObserver = null;
let autoplayMode = 'off'; // 'off' | 'hover' | 'all'

// Load saved autoplay preference
try {
  chrome.storage.local.get('autoplayMode', (data) => {
    if (chrome.runtime.lastError) return;
    if (data.autoplayMode) autoplayMode = data.autoplayMode;
  });
} catch (e) { /* noop */ }

function getTweetId(article) {
  const link = article.querySelector('a[href*="/status/"]');
  if (!link) return null;
  const match = link.href.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function getAuthor(article) {
  const handle = article.querySelector('a[href^="/"][role="link"] span');
  return handle ? handle.textContent : '';
}

function extractMedia(article) {
  const id = getTweetId(article);
  if (!id || collected.has(id)) return;

  const images = [];
  // Tweet photos use this testid
  article.querySelectorAll('div[data-testid="tweetPhoto"] img').forEach(img => {
    if (img.src && img.src.includes('/media/')) {
      // Bump to original size
      const fullRes = img.src.replace(/&name=\w+/, '&name=large');
      images.push(fullRes);
    }
  });

  // Video poster (thumbnail) and video ID for inline playback
  let videoPoster = null;
  let videoId = null;
  const video = article.querySelector('video');
  if (video && video.poster) {
    videoPoster = video.poster;
    const vidMatch = video.poster.match(
      /(?:ext_tw_video_thumb|amplify_video_thumb)\/(\d+)\//
    );
    if (vidMatch) videoId = vidMatch[1];
  }

  if (images.length === 0 && !videoPoster) return;

  const link = article.querySelector('a[href*="/status/"]');
  collected.set(id, {
    images,
    videoPoster,
    videoId,
    link: link ? link.href : null,
    author: getAuthor(article),
  });

  if (galleryOpen) renderGallery();
}

function scan() {
  document.querySelectorAll('article[data-testid="tweet"]').forEach(extractMedia);
}

let fillTimer = null;

function ensureGalleryFillsScreen() {
  if (!galleryEl || !galleryOpen) return;
  if (fillTimer) { clearTimeout(fillTimer); fillTimer = null; }
  // If the gallery has no room to scroll down, keep loading more
  const remaining = galleryEl.scrollHeight - galleryEl.scrollTop - galleryEl.clientHeight;
  if (remaining < 500) {
    scrollUnderlyingPage();
    fillTimer = setTimeout(ensureGalleryFillsScreen, 500);
  }
}

function renderGallery() {
  if (!galleryEl) return;
  const grid = galleryEl.querySelector('.xg-grid');

  for (const [id, data] of collected) {
    if (rendered.has(id)) continue;
    if (data.images.length === 0 && !data.videoPoster) continue;
    rendered.add(id);
    const src = data.images[0] || data.videoPoster;
    const cell = document.createElement('a');
    cell.className = 'xg-cell';
    cell.href = data.link || '#';
    cell.target = '_blank';
    cell.rel = 'noopener';
    if (data.videoPoster && data.images.length === 0) {
      cell.classList.add('xg-video');
      cell.addEventListener('click', (e) => {
        e.preventDefault();
        openVideoPlayer(data);
      });
      // Use a <video> element for autoplay in grid
      const vid = document.createElement('video');
      vid.poster = data.videoPoster;
      vid.muted = true;
      vid.loop = true;
      vid.playsInline = true;
      vid.setAttribute('playsinline', '');
      vid.dataset.videoId = data.videoId || '';
      cell.appendChild(vid);
      // Pop out at native aspect ratio on hover, unmute
      cell.addEventListener('mouseenter', () => {
        if (autoplayMode !== 'all') startCellVideo(cell);
        vid.muted = false;
        syncAllVideoPositions();
        const cellSize = cell.getBoundingClientRect().width;
        cell.style.setProperty('--pop-w', (cellSize * 1.8) + 'px');
        cell.style.setProperty('--pop-h', (cellSize * 1.8) + 'px');
        cell.classList.add('xg-popped');
      });
      cell.addEventListener('mouseleave', () => {
        vid.muted = true;
        cell.classList.remove('xg-popped');
        if (autoplayMode !== 'all') stopCellVideo(cell);
      });
      // Observe for visibility-based playback
      if (videoObserver) videoObserver.observe(cell);
    } else {
      const img = document.createElement('img');
      img.src = src;
      img.loading = 'lazy';
      cell.appendChild(img);
    }
    if (data.images.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'xg-badge';
      badge.textContent = `+${data.images.length - 1}`;
      cell.appendChild(badge);
    }
    grid.appendChild(cell);
  }

  galleryEl.querySelector('.xg-title').textContent = `Gallery (${collected.size})`;
  requestAnimationFrame(syncAllVideoPositions);
  ensureGalleryFillsScreen();
}

function scrollUnderlyingPage() {
  // Scroll up first then back down to re-trigger X's IntersectionObserver
  // A no-op scrollTo (already at bottom) won't fire new events
  window.scrollTo(0, Math.max(0, window.scrollY - 2000));
  setTimeout(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, 100);
}

let syncRaf = null;
function syncAllVideoPositions() {
  if (!galleryEl) return;
  galleryEl.querySelectorAll('.xg-cell.xg-video').forEach(cell => {
    const rect = cell.getBoundingClientRect();
    cell.style.setProperty('--cell-x', (rect.left + rect.width / 2) + 'px');
    cell.style.setProperty('--cell-y', (rect.top + rect.height / 2) + 'px');
    cell.style.setProperty('--cell-w', rect.width + 'px');
  });
}

function throttledSync() {
  if (syncRaf) return;
  syncRaf = requestAnimationFrame(() => {
    syncAllVideoPositions();
    syncRaf = null;
  });
}

function onGalleryScroll() {
  throttledSync();
  const el = galleryEl;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 500;
  if (nearBottom) {
    ensureGalleryFillsScreen();
  }
}

function startCellVideo(cell) {
  const vid = cell.querySelector('video');
  if (!vid || !vid.dataset.videoId || activeHls.has(vid)) return;
  try {
    chrome.runtime.sendMessage(
      { action: 'getVideoUrl', videoId: vid.dataset.videoId },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.url) return;
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(response.url);
          hls.attachMedia(vid);
          hls.on(Hls.Events.MANIFEST_PARSED, () => { vid.play().catch(() => {}); });
          activeHls.set(vid, hls);
        } else if (vid.canPlayType('application/vnd.apple.mpegurl')) {
          vid.src = response.url;
          vid.play().catch(() => {});
        }
      }
    );
  } catch (e) { /* extension context invalidated */ }
}

function stopCellVideo(cell) {
  const vid = cell.querySelector('video');
  if (!vid) return;
  vid.pause();
  const hls = activeHls.get(vid);
  if (hls) {
    hls.detachMedia();
    hls.destroy();
    activeHls.delete(vid);
  }
  vid.removeAttribute('src');
  vid.load(); // reset to poster
}

function destroyAllCellVideos() {
  for (const [vid, hls] of activeHls) {
    hls.destroy();
  }
  activeHls.clear();
}

function setupVideoObserver() {
  if (videoObserver) videoObserver.disconnect();
  videoObserver = new IntersectionObserver((entries) => {
    if (autoplayMode !== 'all') return;
    for (const entry of entries) {
      if (entry.isIntersecting) {
        startCellVideo(entry.target);
      } else {
        stopCellVideo(entry.target);
      }
    }
  }, { root: galleryEl, threshold: 0.1 });
}

const autoplayLabels = { off: 'Off', all: 'On' };

function setAutoplayMode(mode) {
  autoplayMode = mode;
  try { chrome.storage.local.set({ autoplayMode: mode }); } catch (e) { /* noop */ }
  // Update button text
  const btn = galleryEl && galleryEl.querySelector('.xg-autoplay');
  if (btn) btn.textContent = `Autoplay: ${autoplayLabels[mode]}`;
  // Stop all currently playing cell videos
  destroyAllCellVideos();
  // If 'all', restart observer-based playback
  if (mode === 'all' && galleryEl) {
    setupVideoObserver();
    galleryEl.querySelectorAll('.xg-cell.xg-video').forEach(cell => {
      videoObserver.observe(cell);
    });
  }
}

function cycleAutoplayMode() {
  setAutoplayMode(autoplayMode === 'off' ? 'all' : 'off');
}

function openGallery() {
  if (galleryEl) return;
  galleryEl = document.createElement('div');
  galleryEl.id = 'xg-overlay';
  galleryEl.innerHTML = `
    <div class="xg-bar">
      <span class="xg-title">Gallery (${collected.size})</span>
      <div class="xg-bar-actions">
        <button class="xg-autoplay">Autoplay: ${autoplayLabels[autoplayMode]}</button>
        <button class="xg-close">Close</button>
      </div>
    </div>
    <div class="xg-grid"></div>
  `;
  document.body.appendChild(galleryEl);
  document.documentElement.classList.add('xg-no-scroll');
  document.body.classList.add('xg-no-scroll');
  galleryEl.querySelector('.xg-close').addEventListener('click', closeGallery);
  galleryEl.querySelector('.xg-autoplay').addEventListener('click', cycleAutoplayMode);
  galleryEl.addEventListener('scroll', onGalleryScroll);
  galleryOpen = true;
  setupVideoObserver();
  if (autoplayMode === 'all') {
    // Observer will handle starting videos after renderGallery
  }
  renderGallery();
}

function closeGallery() {
  if (fillTimer) { clearTimeout(fillTimer); fillTimer = null; }
  destroyAllCellVideos();
  if (videoObserver) { videoObserver.disconnect(); videoObserver = null; }
  if (galleryEl) {
    galleryEl.removeEventListener('scroll', onGalleryScroll);
    galleryEl.remove();
  }
  document.documentElement.classList.remove('xg-no-scroll');
  document.body.classList.remove('xg-no-scroll');
  rendered.clear();
  galleryEl = null;
  galleryOpen = false;
}

// --- Video Player ---

function openVideoPlayer(data) {
  if (!data.videoId) {
    window.open(data.link, '_blank');
    return;
  }
  chrome.runtime.sendMessage(
    { action: 'getVideoUrl', videoId: data.videoId },
    (response) => {
      if (!response || !response.url) {
        window.open(data.link, '_blank');
        return;
      }
      showPlayerModal(response.url);
    }
  );
}

function showPlayerModal(m3u8Url) {
  closeVideoPlayer();

  const modal = document.createElement('div');
  modal.id = 'xg-player-modal';

  const backdrop = document.createElement('div');
  backdrop.className = 'xg-player-backdrop';
  backdrop.addEventListener('click', closeVideoPlayer);

  const container = document.createElement('div');
  container.className = 'xg-player-container';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'xg-player-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', closeVideoPlayer);

  const videoEl = document.createElement('video');
  videoEl.className = 'xg-player-video';
  videoEl.controls = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;

  container.appendChild(closeBtn);
  container.appendChild(videoEl);
  modal.appendChild(backdrop);
  modal.appendChild(container);
  document.body.appendChild(modal);

  // Initialize HLS playback
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(m3u8Url);
    hls.attachMedia(videoEl);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      videoEl.play().catch(() => {});
    });
    modal._hls = hls;
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    videoEl.src = m3u8Url;
    videoEl.play();
  }

  // Close on Escape
  modal._keyHandler = (e) => {
    if (e.key === 'Escape') closeVideoPlayer();
  };
  document.addEventListener('keydown', modal._keyHandler);
}

function closeVideoPlayer() {
  const modal = document.getElementById('xg-player-modal');
  if (!modal) return;
  if (modal._hls) modal._hls.destroy();
  if (modal._keyHandler) document.removeEventListener('keydown', modal._keyHandler);
  modal.remove();
}

function toggleGallery() {
  if (galleryOpen) closeGallery();
  else openGallery();
}

// Watch for new tweets as the user scrolls (debounced)
let scanTimer = null;
const observer = new MutationObserver(() => {
  if (scanTimer) return;
  scanTimer = setTimeout(() => { scan(); scanTimer = null; }, 200);
});
observer.observe(document.body, { childList: true, subtree: true });
scan();

// Listen for the toolbar button click
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'toggle') toggleGallery();
});

// Also bind a hotkey: Ctrl+Shift+G
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'G') {
    e.preventDefault();
    toggleGallery();
  }
});
