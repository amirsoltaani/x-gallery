// Captures media from tweets as they appear and shows them in a grid overlay.

const collected = new Map(); // tweetId -> { images, videoPoster, videoId, link, name, handle, text }
const rendered = new Set();  // tweetIds already in the grid
const activeHls = new Map(); // videoElement -> Hls instance
let galleryOpen = false;
let galleryEl = null;
let videoObserver = null;
let autoplayMode = 'off';    // 'off' | 'all'
let mediaFilter = 'all';     // 'all' | 'photos' | 'videos'   (feat/media-filter)
let layoutMode = 'grid';     // 'grid' | 'masonry'            (feat/masonry)
let tileSize = 220;          // px, tile width / masonry column width (feat/density)
let searchQuery = '';        // session-only text filter, lowercased (feat/search)
let searchDebounce = null;
const TILE_MIN = 120, TILE_MAX = 400, TILE_STEP = 40;

// Load saved preferences in a single multi-key read
try {
  chrome.storage.local.get(['autoplayMode', 'mediaFilter', 'layoutMode', 'tileSize'], (data) => {
    if (chrome.runtime.lastError) return;
    if (data.autoplayMode === 'off' || data.autoplayMode === 'all') autoplayMode = data.autoplayMode;
    if (data.mediaFilter === 'all' || data.mediaFilter === 'photos' || data.mediaFilter === 'videos') mediaFilter = data.mediaFilter;
    if (data.layoutMode === 'grid' || data.layoutMode === 'masonry') layoutMode = data.layoutMode;
    if (typeof data.tileSize === 'number') tileSize = Math.max(TILE_MIN, Math.min(TILE_MAX, data.tileSize));
  });
} catch (e) { /* noop */ }

function getTweetId(article) {
  const link = article.querySelector('a[href*="/status/"]');
  if (!link) return null;
  const match = link.href.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function getPostInfo(article, statusLink) {
  // Handle comes straight from the status URL: /USERNAME/status/ID
  let handle = '';
  if (statusLink) {
    const m = statusLink.match(/(?:twitter|x)\.com\/([^/]+)\/status\//);
    if (m) handle = '@' + m[1];
  }
  // Display name from the User-Name block (strip any trailing @handle/timestamp)
  let name = '';
  const nameEl = article.querySelector('div[data-testid="User-Name"]');
  if (nameEl) {
    const firstLink = nameEl.querySelector('a[role="link"]');
    if (firstLink) {
      name = firstLink.textContent.trim();
      const at = name.indexOf('@');
      if (at > 0) name = name.slice(0, at).trim();
    }
  }
  // Tweet text
  let text = '';
  const textEl = article.querySelector('div[data-testid="tweetText"]');
  if (textEl) text = textEl.textContent.trim();
  return { name, handle, text };
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

  const linkEl = article.querySelector('a[href*="/status/"]');
  const link = linkEl ? linkEl.href : null;
  const info = getPostInfo(article, link);
  collected.set(id, {
    images,
    videoPoster,
    videoId,
    link,
    name: info.name,
    handle: info.handle,
    text: info.text,
  });

  if (galleryOpen) renderGallery();
}

function scan() {
  document.querySelectorAll('article[data-testid="tweet"]').forEach(extractMedia);
}

let fillTimer = null;
let lastFillSize = 0;
let fillRetries = 0;
const MAX_FILL_RETRIES = 8;

function ensureGalleryFillsScreen() {
  if (!galleryEl || !galleryOpen) return;
  if (fillTimer) { clearTimeout(fillTimer); fillTimer = null; }
  // If the gallery has no room to scroll down, keep loading more
  const remaining = galleryEl.scrollHeight - galleryEl.scrollTop - galleryEl.clientHeight;
  if (remaining < 500) {
    // Stop if no new content was loaded after several attempts
    if (collected.size === lastFillSize) {
      fillRetries++;
      if (fillRetries >= MAX_FILL_RETRIES) return;
    } else {
      fillRetries = 0;
      lastFillSize = collected.size;
    }
    scrollUnderlyingPage();
    fillTimer = setTimeout(ensureGalleryFillsScreen, 1000);
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
    const cell = document.createElement('div');
    cell.className = 'xg-cell';
    cell.dataset.search = `${data.name || ''} ${data.handle || ''} ${data.text || ''}`.toLowerCase();
    if (data.videoPoster && data.images.length === 0) {
      cell.classList.add('xg-video');
      cell.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        openLightbox(id, 0);
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
        if (layoutMode !== 'masonry') {
          syncAllVideoPositions();
          const cellSize = cell.getBoundingClientRect().width;
          cell.style.setProperty('--pop-w', (cellSize * 1.8) + 'px');
          cell.style.setProperty('--pop-h', (cellSize * 1.8) + 'px');
          cell.classList.add('xg-popped');
        }
      });
      cell.addEventListener('mouseleave', () => {
        vid.muted = true;
        cell.classList.remove('xg-popped');
        if (autoplayMode !== 'all') stopCellVideo(cell);
      });
      // Observe for visibility-based playback
      if (videoObserver) videoObserver.observe(cell);
    } else {
      cell.classList.add('xg-photo');
      cell.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        openLightbox(id, 0);
      });
      const img = document.createElement('img');
      img.src = src;
      img.loading = 'lazy';
      cell.appendChild(img);
      cell.addEventListener('mouseenter', () => {
        if (layoutMode !== 'masonry') {
          syncAllVideoPositions();
          const cellSize = cell.getBoundingClientRect().width;
          cell.style.setProperty('--pop-w', (cellSize * 1.8) + 'px');
          cell.style.setProperty('--pop-h', (cellSize * 1.8) + 'px');
          cell.classList.add('xg-popped');
        }
      });
      cell.addEventListener('mouseleave', () => {
        cell.classList.remove('xg-popped');
      });
    }
    if (data.link) {
      const postLink = document.createElement('a');
      postLink.className = 'xg-post-link';
      postLink.href = data.link;
      postLink.target = '_blank';
      postLink.rel = 'noopener';
      postLink.title = 'Open post on X';
      postLink.textContent = 'View post ↗';
      // Follow the link without triggering the cell's lightbox click
      postLink.addEventListener('click', (e) => e.stopPropagation());
      cell.appendChild(postLink);
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
  applyFilters();
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
  if (!galleryEl || layoutMode === 'masonry') return;
  galleryEl.querySelectorAll('.xg-cell.xg-video, .xg-cell.xg-photo').forEach(cell => {
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
    // Reset retries when user actively scrolls to bottom
    fillRetries = 0;
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

const layoutLabels = { grid: 'Grid', masonry: 'Masonry' };

// Show/hide grid cells based on the media-type filter and the text search.
// Read by feat/media-filter (mediaFilter) and feat/search (searchQuery).
function applyFilters() {
  if (!galleryEl) return;
  galleryEl.querySelectorAll('.xg-cell').forEach((cell) => {
    const isVideo = cell.classList.contains('xg-video');
    const typeOk = mediaFilter === 'all' ? true : (mediaFilter === 'videos' ? isVideo : !isVideo);
    const textOk = !searchQuery || (cell.dataset.search || '').includes(searchQuery);
    const show = typeOk && textOk;
    cell.classList.toggle('xg-hidden', !show);
    if (!show && isVideo) stopCellVideo(cell); // never leave a hidden video playing
  });
  if (layoutMode !== 'masonry') requestAnimationFrame(syncAllVideoPositions);
}

// feat/media-filter: All / Photos / Videos
function setMediaFilter(mode) {
  mediaFilter = mode;
  try { chrome.storage.local.set({ mediaFilter: mode }); } catch (e) { /* noop */ }
  if (galleryEl) {
    galleryEl.querySelectorAll('.xg-filter button').forEach((b) =>
      b.classList.toggle('active', b.dataset.filter === mode));
    if (mode === 'photos') galleryEl.querySelectorAll('.xg-cell.xg-video').forEach(stopCellVideo);
  }
  applyFilters();
  // Re-arm autoplay for the now-visible videos
  if (autoplayMode === 'all' && mode !== 'photos' && videoObserver && galleryEl) {
    galleryEl.querySelectorAll('.xg-cell.xg-video:not(.xg-hidden)').forEach((c) => videoObserver.observe(c));
  }
}

// feat/search: debounced author/text filter
function handleSearchInput(value) {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = (value || '').trim().toLowerCase();
    applyFilters();
  }, 200);
}

// feat/density: adjustable tile size (shared --xg-tile drives grid + masonry column width)
function setTileSize(px) {
  tileSize = Math.max(TILE_MIN, Math.min(TILE_MAX, px));
  try { chrome.storage.local.set({ tileSize }); } catch (e) { /* noop */ }
  if (galleryEl) {
    const grid = galleryEl.querySelector('.xg-grid');
    if (grid) grid.style.setProperty('--xg-tile', tileSize + 'px');
    const minus = galleryEl.querySelector('.xg-tile-minus');
    const plus = galleryEl.querySelector('.xg-tile-plus');
    if (minus) minus.disabled = tileSize <= TILE_MIN;
    if (plus) plus.disabled = tileSize >= TILE_MAX;
  }
  if (layoutMode !== 'masonry') requestAnimationFrame(syncAllVideoPositions);
}

// feat/masonry: square grid <-> aspect-preserving columns
function setLayoutMode(mode) {
  layoutMode = mode;
  try { chrome.storage.local.set({ layoutMode: mode }); } catch (e) { /* noop */ }
  if (galleryEl) galleryEl.classList.toggle('xg-masonry', mode === 'masonry');
  const btn = galleryEl && galleryEl.querySelector('.xg-layout');
  if (btn) btn.textContent = 'Layout: ' + layoutLabels[mode];
  if (mode === 'grid') requestAnimationFrame(syncAllVideoPositions);
}

function openGallery() {
  if (galleryEl) return;
  galleryEl = document.createElement('div');
  galleryEl.id = 'xg-overlay';
  galleryEl.innerHTML = `
    <div class="xg-bar">
      <span class="xg-title">Gallery (${collected.size})</span>
      <div class="xg-bar-actions">
        <input class="xg-search" type="search" placeholder="Search author or text" aria-label="Search">
        <div class="xg-filter">
          <button data-filter="all">All</button>
          <button data-filter="photos">Photos</button>
          <button data-filter="videos">Videos</button>
        </div>
        <div class="xg-density">
          <button class="xg-tile-minus" aria-label="Smaller tiles">−</button>
          <button class="xg-tile-plus" aria-label="Larger tiles">+</button>
        </div>
        <button class="xg-layout">Layout: ${layoutLabels[layoutMode]}</button>
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
  galleryEl.querySelector('.xg-layout').addEventListener('click', () => setLayoutMode(layoutMode === 'grid' ? 'masonry' : 'grid'));
  galleryEl.querySelector('.xg-tile-minus').addEventListener('click', () => setTileSize(tileSize - TILE_STEP));
  galleryEl.querySelector('.xg-tile-plus').addEventListener('click', () => setTileSize(tileSize + TILE_STEP));
  galleryEl.querySelectorAll('.xg-filter button').forEach((b) => b.addEventListener('click', () => setMediaFilter(b.dataset.filter)));
  galleryEl.querySelector('.xg-search').addEventListener('input', (e) => handleSearchInput(e.target.value));
  galleryEl.addEventListener('scroll', onGalleryScroll);
  // Initialize control state from restored preferences
  galleryEl.classList.toggle('xg-masonry', layoutMode === 'masonry');
  galleryEl.querySelector('.xg-grid').style.setProperty('--xg-tile', tileSize + 'px');
  galleryEl.querySelector('.xg-tile-minus').disabled = tileSize <= TILE_MIN;
  galleryEl.querySelector('.xg-tile-plus').disabled = tileSize >= TILE_MAX;
  const activeFilterBtn = galleryEl.querySelector(`.xg-filter button[data-filter="${mediaFilter}"]`);
  if (activeFilterBtn) activeFilterBtn.classList.add('active');
  galleryOpen = true;
  lastFillSize = 0;
  fillRetries = 0;
  setupVideoObserver();
  if (autoplayMode === 'all') {
    // Observer will handle starting videos after renderGallery
  }
  renderGallery();
}

function closeGallery() {
  if (fillTimer) { clearTimeout(fillTimer); fillTimer = null; }
  closeLightbox();
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

// --- Lightbox (photos + videos with arrow navigation) ---

let lightboxState = null;

function buildMediaList() {
  const list = [];
  for (const [id, data] of collected) {
    const meta = { name: data.name, handle: data.handle, text: data.text };
    if (data.images.length > 0) {
      data.images.forEach((src, idx) => {
        list.push({ tweetId: id, type: 'image', src, link: data.link, imageIndex: idx, ...meta });
      });
    } else if (data.videoPoster) {
      list.push({ tweetId: id, type: 'video', poster: data.videoPoster, videoId: data.videoId, link: data.link, ...meta });
    }
  }
  return list;
}

function openLightbox(tweetId, imageIndex = 0) {
  const list = buildMediaList();
  let index = list.findIndex(item =>
    item.tweetId === tweetId &&
    (item.type === 'video' || item.imageIndex === imageIndex)
  );
  if (index < 0) index = 0;
  if (list.length === 0) return;

  closeLightbox();

  const modal = document.createElement('div');
  modal.id = 'xg-lightbox';
  modal.innerHTML = `
    <div class="xg-lb-backdrop"></div>
    <div class="xg-lb-actions">
      <a class="xg-lb-post-link" target="_blank" rel="noopener">View post \u2197</a>
      <button class="xg-lb-download" aria-label="Download">Download</button>
    </div>
    <button class="xg-lb-close" aria-label="Close">\u00d7</button>
    <button class="xg-lb-prev" aria-label="Previous">\u2039</button>
    <button class="xg-lb-next" aria-label="Next">\u203a</button>
    <div class="xg-lb-counter"></div>
    <div class="xg-lb-info"></div>
    <div class="xg-lb-stage"></div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('.xg-lb-backdrop').addEventListener('click', closeLightbox);
  modal.querySelector('.xg-lb-close').addEventListener('click', closeLightbox);
  modal.querySelector('.xg-lb-prev').addEventListener('click', () => navigateLightbox(-1));
  modal.querySelector('.xg-lb-next').addEventListener('click', () => navigateLightbox(1));
  modal.querySelector('.xg-lb-download').addEventListener('click', downloadCurrentItem);

  const keyHandler = (e) => {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') navigateLightbox(-1);
    else if (e.key === 'ArrowRight') navigateLightbox(1);
    else if (e.key === 'd' || e.key === 'D') downloadCurrentItem();
    else if (e.key === 'Enter') {
      const it = lightboxState && lightboxState.list[lightboxState.index];
      if (it && it.link) window.open(it.link, '_blank', 'noopener');
    } else if (e.key === ' ') {
      e.preventDefault();
      const v = lightboxState && lightboxState.videoEl;
      if (v) { v.paused ? v.play().catch(() => {}) : v.pause(); }
    } else if (e.key === 'm' || e.key === 'M') {
      const v = lightboxState && lightboxState.videoEl;
      if (v) v.muted = !v.muted;
    }
  };
  document.addEventListener('keydown', keyHandler);

  lightboxState = { list, index, modal, hls: null, keyHandler };
  showLightboxAt(index);
}

function navigateLightbox(delta) {
  if (!lightboxState) return;
  // Re-snapshot — collected may have grown since the lightbox opened
  lightboxState.list = buildMediaList();

  const target = lightboxState.index + delta;
  if (target < 0) return;
  if (target < lightboxState.list.length) {
    showLightboxAt(target);
    return;
  }
  if (delta > 0) tryLoadMoreAndAdvance(target);
}

let lightboxLoadingTimer = null;

function tryLoadMoreAndAdvance(target) {
  if (!lightboxState) return;
  const counter = lightboxState.modal.querySelector('.xg-lb-counter');
  const nextBtn = lightboxState.modal.querySelector('.xg-lb-next');
  counter.textContent = 'Loading more…';
  nextBtn.disabled = true;

  if (lightboxLoadingTimer) clearTimeout(lightboxLoadingTimer);
  let attempts = 0;
  const startSize = lightboxState.list.length;

  const tick = () => {
    if (!lightboxState) return;
    scrollUnderlyingPage();
    lightboxLoadingTimer = setTimeout(() => {
      if (!lightboxState) return;
      const newList = buildMediaList();
      if (newList.length > startSize) {
        lightboxState.list = newList;
        lightboxLoadingTimer = null;
        showLightboxAt(Math.min(target, newList.length - 1));
        return;
      }
      attempts++;
      if (attempts < 6) {
        tick();
      } else {
        lightboxLoadingTimer = null;
        showLightboxAt(lightboxState.index);
      }
    }, 700);
  };
  tick();
}

function renderPostInfo(container, item) {
  container.innerHTML = '';
  if (!item || (!item.name && !item.handle && !item.text)) {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';
  if (item.name || item.handle) {
    const meta = document.createElement('div');
    meta.className = 'xg-lb-info-meta';
    if (item.name) {
      const n = document.createElement('span');
      n.className = 'xg-lb-info-name';
      n.textContent = item.name;
      meta.appendChild(n);
    }
    if (item.handle) {
      const h = document.createElement('a');
      h.className = 'xg-lb-info-handle';
      h.textContent = item.handle;
      h.href = 'https://x.com/' + item.handle.replace(/^@/, '');
      h.target = '_blank';
      h.rel = 'noopener';
      meta.appendChild(h);
    }
    container.appendChild(meta);
  }
  if (item.text) {
    const t = document.createElement('div');
    t.className = 'xg-lb-info-text';
    t.textContent = item.text;
    container.appendChild(t);
  }
}

// --- One-click media download (images + HLS videos), entirely client-side ---

function mediaUsername(item) {
  if (item.handle) return item.handle.replace(/^@/, '');
  if (item.link) {
    const m = item.link.match(/(?:twitter|x)\.com\/([^/]+)\/status\//);
    if (m) return m[1];
  }
  return 'x';
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Fetch many URLs into ArrayBuffers, preserving order, with bounded concurrency
async function fetchBuffers(urls, onProgress, concurrency = 6) {
  const results = new Array(urls.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < urls.length) {
      const idx = next++;
      const r = await fetch(urls[idx]);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      results[idx] = await r.arrayBuffer();
      if (onProgress) onProgress(++done, urls.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker)
  );
  return results;
}

async function downloadImage(item) {
  const fmt = item.src.match(/[?&]format=(\w+)/);
  const ext = fmt ? fmt[1] : 'jpg';
  const idx = (item.imageIndex || 0) + 1;
  // Prefer original resolution, falling back to the displayed size
  const origUrl = item.src.replace(/([?&]name=)\w+/, '$1orig');
  let res = await fetch(origUrl);
  if (!res.ok) res = await fetch(item.src);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  triggerBlobDownload(blob, `${mediaUsername(item)}_${item.tweetId}_${idx}.${ext}`);
}

function getVideoUrlAsync(videoId) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'getVideoUrl', videoId }, (r) => {
        resolve(chrome.runtime.lastError || !r ? null : r.url || null);
      });
    } catch (e) { resolve(null); }
  });
}

// Parse an HLS media playlist into its init-segment URL (#EXT-X-MAP) and segments
function parseMediaPlaylist(text, baseUrl) {
  const map = text.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/);
  const initUrl = map ? new URL(map[1], baseUrl).href : null;
  const segUrls = text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((u) => new URL(u, baseUrl).href);
  return { initUrl, segUrls };
}

// --- ISO-BMFF box helpers for muxing X's separate audio + video fMP4 tracks ---
function _u32(a, o) { return (a[o] << 24 | a[o + 1] << 16 | a[o + 2] << 8 | a[o + 3]) >>> 0; }
function _wu32(a, o, v) { a[o] = (v >>> 24) & 255; a[o + 1] = (v >>> 16) & 255; a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255; }
function _boxType(a, o) { return String.fromCharCode(a[o + 4], a[o + 5], a[o + 6], a[o + 7]); }
function _boxes(a, start, end) {
  const list = [];
  let o = start;
  while (o + 8 <= end) {
    let size = _u32(a, o);
    let hdr = 8;
    if (size === 1) { size = _u32(a, o + 12); hdr = 16; } // 64-bit size (low 32 bits; assumes < 4GB)
    else if (size === 0) size = end - o;
    if (size < 8) break;
    list.push({ type: _boxType(a, o), start: o, end: o + size, hdr });
    o += size;
  }
  return list;
}
function _find(a, start, end, type) { return _boxes(a, start, end).find((b) => b.type === type); }
function _copy(a, b) { return a.slice(b.start, b.end); }
function _mkbox(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  _wu32(out, 0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}
function _concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// Offset of track_ID within a tkhd box (depends on the box version flag)
function _tkhdTrackIdOffset(arr, tkhd) {
  return arr[tkhd.start + 8] === 1 ? tkhd.start + 28 : tkhd.start + 20;
}

// Combine a video-only fMP4 and an audio-only fMP4 (CMAF) into one MP4 with both
// tracks. Verified against X's amplify/ext_tw_video HLS streams.
function muxVideoAudio(vInit, vSegs, aInit, aSegs) {
  const ftyp = _find(vInit, 0, vInit.length, 'ftyp');
  const vMoov = _find(vInit, 0, vInit.length, 'moov');
  if (!ftyp || !vMoov) throw new Error('bad video init segment');
  const vMvhd = _find(vInit, vMoov.start + vMoov.hdr, vMoov.end, 'mvhd');
  const vTrak = _find(vInit, vMoov.start + vMoov.hdr, vMoov.end, 'trak');
  const vMvex = _find(vInit, vMoov.start + vMoov.hdr, vMoov.end, 'mvex');
  const vTrex = vMvex && _find(vInit, vMvex.start + vMvex.hdr, vMvex.end, 'trex');
  const vTkhd = vTrak && _find(vInit, vTrak.start + vTrak.hdr, vTrak.end, 'tkhd');
  if (!vMvhd || !vTrak || !vTrex || !vTkhd) throw new Error('unexpected video init layout');
  const videoId = _u32(vInit, _tkhdTrackIdOffset(vInit, vTkhd));
  const audioId = videoId + 1;

  const aMoov = _find(aInit, 0, aInit.length, 'moov');
  const aTrak = aMoov && _find(aInit, aMoov.start + aMoov.hdr, aMoov.end, 'trak');
  const aMvex = aMoov && _find(aInit, aMoov.start + aMoov.hdr, aMoov.end, 'mvex');
  const aTrex = aMvex && _find(aInit, aMvex.start + aMvex.hdr, aMvex.end, 'trex');
  if (!aTrak || !aTrex) throw new Error('unexpected audio init layout');

  // Build a merged moov: video trak as-is + audio trak (remapped to audioId) + both trex
  const mvhd = _copy(vInit, vMvhd);
  _wu32(mvhd, mvhd.length - 4, audioId + 1); // next_track_ID
  const vTrakB = _copy(vInit, vTrak);
  const aTrakB = _copy(aInit, aTrak);
  const aTkhd = _find(aTrakB, 8, aTrakB.length, 'tkhd');
  if (!aTkhd) throw new Error('audio tkhd missing');
  _wu32(aTrakB, _tkhdTrackIdOffset(aTrakB, aTkhd), audioId);
  const vTrexB = _copy(vInit, vTrex);
  const aTrexB = _copy(aInit, aTrex);
  _wu32(aTrexB, 12, audioId); // trex track_ID
  const moov = _mkbox('moov', _concat([mvhd, vTrakB, aTrakB, _mkbox('mvex', _concat([vTrexB, aTrexB]))]));

  // Each media segment -> [moof, mdat], patching the traf's tfhd track_ID
  function fragOf(seg, trackId) {
    let moof = null;
    let mdat = null;
    for (const b of _boxes(seg, 0, seg.length)) {
      if (b.type === 'moof') {
        moof = _copy(seg, b);
        const traf = _find(moof, 8, moof.length, 'traf');
        const tfhd = traf && _find(moof, traf.start + 8, traf.end, 'tfhd');
        if (tfhd) _wu32(moof, tfhd.start + 12, trackId);
      } else if (b.type === 'mdat') {
        mdat = _copy(seg, b);
      }
    }
    return moof && mdat ? [moof, mdat] : null;
  }
  const vFrags = vSegs.map((s) => fragOf(s, videoId)).filter(Boolean);
  const aFrags = aSegs.map((s) => fragOf(s, audioId)).filter(Boolean);

  // Interleave fragments by index and give every moof a fresh sequence number
  const parts = [_copy(vInit, ftyp), moov];
  let seq = 1;
  const n = Math.max(vFrags.length, aFrags.length);
  for (let i = 0; i < n; i++) {
    for (const grp of [vFrags[i], aFrags[i]]) {
      if (!grp) continue;
      const mfhd = _find(grp[0], 8, grp[0].length, 'mfhd');
      if (mfhd) _wu32(grp[0], mfhd.start + 12, seq++);
      parts.push(grp[0], grp[1]);
    }
  }
  return new Blob(parts, { type: 'video/mp4' });
}

async function downloadVideo(item, onProgress) {
  const masterUrl = await getVideoUrlAsync(item.videoId);
  if (!masterUrl) throw new Error('Video stream not found yet');

  let videoMediaUrl = masterUrl;
  let audioMediaUrl = null;
  let playlist = await (await fetch(masterUrl)).text();

  // Master playlist: pick the highest-bandwidth video variant and its audio group
  if (/#EXT-X-STREAM-INF/.test(playlist)) {
    const lines = playlist.split(/\r?\n/);
    const audios = [];
    for (const ln of lines) {
      if (ln.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/.test(ln)) {
        audios.push({
          uri: (ln.match(/URI="([^"]+)"/) || [])[1],
          grp: (ln.match(/GROUP-ID="([^"]+)"/) || [])[1],
          def: /DEFAULT=YES/.test(ln),
        });
      }
    }
    let best = null, bestBw = -1, group = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
        const uri = (lines[i + 1] || '').trim();
        if (uri && !uri.startsWith('#') && bw >= bestBw) {
          bestBw = bw;
          best = uri;
          group = (lines[i].match(/AUDIO="([^"]+)"/) || [])[1] || null;
        }
      }
    }
    if (!best) throw new Error('No video variant found');
    videoMediaUrl = new URL(best, masterUrl).href;
    const aud = audios.find((a) => a.grp === group && a.def)
      || audios.find((a) => a.grp === group)
      || audios.find((a) => a.def) || audios[0];
    if (aud && aud.uri) audioMediaUrl = new URL(aud.uri, masterUrl).href;
    playlist = await (await fetch(videoMediaUrl)).text();
  }

  const video = parseMediaPlaylist(playlist, videoMediaUrl);
  if (video.segUrls.length === 0) throw new Error('No video segments found');
  let audio = null;
  if (audioMediaUrl) {
    audio = parseMediaPlaylist(await (await fetch(audioMediaUrl)).text(), audioMediaUrl);
  }

  const name = mediaUsername(item);
  const toU8 = (ab) => new Uint8Array(ab);

  // X demuxes audio into its own fMP4 rendition — fetch both tracks and mux them
  if (video.initUrl && audio && audio.initUrl && audio.segUrls.length) {
    const urls = [video.initUrl, ...video.segUrls, audio.initUrl, ...audio.segUrls];
    const bufs = await fetchBuffers(urls, onProgress);
    const vCount = video.segUrls.length;
    const vInit = toU8(bufs[0]);
    const vSegs = bufs.slice(1, 1 + vCount).map(toU8);
    const aInit = toU8(bufs[1 + vCount]);
    const aSegs = bufs.slice(2 + vCount).map(toU8);
    triggerBlobDownload(muxVideoAudio(vInit, vSegs, aInit, aSegs), `${name}_${item.tweetId}.mp4`);
    return;
  }

  // Single track (already muxed, or video-only). fMP4 -> .mp4, MPEG-TS -> .ts
  const parts = video.initUrl ? [video.initUrl, ...video.segUrls] : video.segUrls;
  const buffers = await fetchBuffers(parts, onProgress);
  const ext = video.initUrl ? 'mp4' : 'ts';
  triggerBlobDownload(
    new Blob(buffers, { type: video.initUrl ? 'video/mp4' : 'video/mp2t' }),
    `${name}_${item.tweetId}.${ext}`
  );
}

async function downloadCurrentItem() {
  if (!lightboxState) return;
  const item = lightboxState.list[lightboxState.index];
  const btn = lightboxState.modal.querySelector('.xg-lb-download');
  if (!item || !btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    if (item.type === 'image') {
      await downloadImage(item);
    } else {
      await downloadVideo(item, (done, total) => {
        btn.textContent = `Downloading… ${Math.round((done / total) * 100)}%`;
      });
    }
    btn.textContent = 'Saved ✓';
  } catch (e) {
    btn.textContent = 'Failed';
  }
  setTimeout(() => {
    // Only reset if the modal is still showing this same button
    if (btn.isConnected) { btn.textContent = 'Download'; btn.disabled = false; }
  }, 1500);
}

function showLightboxAt(index) {
  if (!lightboxState) return;
  lightboxState.index = index;
  const item = lightboxState.list[index];
  const stage = lightboxState.modal.querySelector('.xg-lb-stage');
  const counter = lightboxState.modal.querySelector('.xg-lb-counter');
  const prevBtn = lightboxState.modal.querySelector('.xg-lb-prev');
  const nextBtn = lightboxState.modal.querySelector('.xg-lb-next');
  const postLink = lightboxState.modal.querySelector('.xg-lb-post-link');

  if (item.link) {
    postLink.href = item.link;
    postLink.style.display = '';
  } else {
    postLink.style.display = 'none';
  }

  renderPostInfo(lightboxState.modal.querySelector('.xg-lb-info'), item);

  if (lightboxState.hls) {
    lightboxState.hls.destroy();
    lightboxState.hls = null;
  }
  stage.innerHTML = '';

  if (item.type === 'image') {
    const img = document.createElement('img');
    img.className = 'xg-lb-media';
    img.src = item.src;
    stage.appendChild(img);
    lightboxState.videoEl = null;
  } else {
    const videoEl = document.createElement('video');
    videoEl.className = 'xg-lb-media';
    videoEl.controls = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.poster = item.poster || '';
    stage.appendChild(videoEl);
    lightboxState.videoEl = videoEl;

    if (item.videoId) {
      try {
        chrome.runtime.sendMessage(
          { action: 'getVideoUrl', videoId: item.videoId },
          (response) => {
            if (chrome.runtime.lastError) return;
            if (!lightboxState || lightboxState.list[lightboxState.index] !== item) return;
            if (!response || !response.url) return;
            if (typeof Hls !== 'undefined' && Hls.isSupported()) {
              const hls = new Hls();
              hls.loadSource(response.url);
              hls.attachMedia(videoEl);
              hls.on(Hls.Events.MANIFEST_PARSED, () => { videoEl.play().catch(() => {}); });
              lightboxState.hls = hls;
            } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
              videoEl.src = response.url;
              videoEl.play().catch(() => {});
            }
          }
        );
      } catch (e) { /* extension context invalidated */ }
    }
  }

  counter.textContent = `${index + 1} / ${lightboxState.list.length}`;
  prevBtn.disabled = index === 0;
  nextBtn.disabled = index === lightboxState.list.length - 1;
}

function closeLightbox() {
  if (lightboxLoadingTimer) {
    clearTimeout(lightboxLoadingTimer);
    lightboxLoadingTimer = null;
  }
  if (!lightboxState) return;
  if (lightboxState.hls) lightboxState.hls.destroy();
  if (lightboxState.keyHandler) document.removeEventListener('keydown', lightboxState.keyHandler);
  lightboxState.modal.remove();
  lightboxState = null;
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
