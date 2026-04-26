// Captures media from tweets as they appear and shows them in a grid overlay.

const collected = new Map(); // tweetId -> { images: [], videoPoster, link, author }
const rendered = new Set();  // tweetIds already in the grid
let galleryOpen = false;
let galleryEl = null;

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

  // Video poster (thumbnail) as a fallback marker for video tweets
  let videoPoster = null;
  const video = article.querySelector('video');
  if (video && video.poster) videoPoster = video.poster;

  if (images.length === 0 && !videoPoster) return;

  const link = article.querySelector('a[href*="/status/"]');
  collected.set(id, {
    images,
    videoPoster,
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
    }
    const img = document.createElement('img');
    img.src = src;
    img.loading = 'lazy';
    cell.appendChild(img);
    if (data.images.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'xg-badge';
      badge.textContent = `+${data.images.length - 1}`;
      cell.appendChild(badge);
    }
    grid.appendChild(cell);
  }

  galleryEl.querySelector('.xg-title').textContent = `Gallery (${collected.size})`;
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

function onGalleryScroll() {
  const el = galleryEl;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 500;
  if (nearBottom) {
    // Reuse the fill loop — it keeps scrolling until the gallery has more content
    ensureGalleryFillsScreen();
  }
}

function openGallery() {
  if (galleryEl) return;
  galleryEl = document.createElement('div');
  galleryEl.id = 'xg-overlay';
  galleryEl.innerHTML = `
    <div class="xg-bar">
      <span class="xg-title">Gallery (${collected.size})</span>
      <button class="xg-close">Close</button>
    </div>
    <div class="xg-grid"></div>
  `;
  document.body.appendChild(galleryEl);
  document.documentElement.classList.add('xg-no-scroll');
  document.body.classList.add('xg-no-scroll');
  galleryEl.querySelector('.xg-close').addEventListener('click', closeGallery);
  galleryEl.addEventListener('scroll', onGalleryScroll);
  galleryOpen = true;
  renderGallery();
}

function closeGallery() {
  if (fillTimer) { clearTimeout(fillTimer); fillTimer = null; }
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

function toggleGallery() {
  if (galleryOpen) closeGallery();
  else openGallery();
}

// Watch for new tweets as the user scrolls
const observer = new MutationObserver(() => scan());
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
