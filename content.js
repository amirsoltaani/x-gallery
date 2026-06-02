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
        syncAllVideoPositions();
        const cellSize = cell.getBoundingClientRect().width;
        cell.style.setProperty('--pop-w', (cellSize * 1.8) + 'px');
        cell.style.setProperty('--pop-h', (cellSize * 1.8) + 'px');
        cell.classList.add('xg-popped');
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
    <a class="xg-lb-post-link" target="_blank" rel="noopener">View post \u2197</a>
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

  const keyHandler = (e) => {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') navigateLightbox(-1);
    else if (e.key === 'ArrowRight') navigateLightbox(1);
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
  } else {
    const videoEl = document.createElement('video');
    videoEl.className = 'xg-lb-media';
    videoEl.controls = true;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.poster = item.poster || '';
    stage.appendChild(videoEl);

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
