const videoMap = new Map(); // videoId -> m3u8Url

// Capture m3u8 requests from X's video CDN
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const match = details.url.match(
      /video\.twimg\.com\/(?:ext_tw_video|amplify_video)\/(\d+)\//
    );
    if (match && !videoMap.has(match[1])) {
      videoMap.set(match[1], details.url);
    }
  },
  { urls: ['*://video.twimg.com/*.m3u8*'] }
);

// Toggle gallery on extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
  }
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getVideoUrl') {
    sendResponse({ url: videoMap.get(msg.videoId) || null });
  }
  return true;
});
