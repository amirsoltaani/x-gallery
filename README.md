# X Gallery View

A Chrome extension that turns your X (Twitter) timeline into a media-first gallery grid.

Click the extension icon and the page flips into a clean grid of every image and video from the tweets you've loaded. Hover a video to play it with sound; the clip pops out at its native aspect ratio so wide and tall videos look right. Scroll to the bottom and the underlying timeline keeps loading more content.

## Features

- One-click toggle between timeline and gallery view
- Images and inline-playing videos in a single responsive grid
- Hover a video to unmute and pop it out at native aspect ratio
- Autoplay toggle (Off / On) with persistent preference
- Infinite scroll — gallery keeps growing as the timeline loads more

## Install

### From the Chrome Web Store
*(Pending review)*

### Load unpacked (development)

1. Clone this repo:
   ```
   git clone https://github.com/amirsoltaani/x-gallery.git
   ```
2. In Chrome, open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the cloned folder

## Usage

1. Open [x.com](https://x.com)
2. Click the X Gallery View toolbar icon to enter gallery view
3. Use the **Autoplay** button in the gallery's top bar to toggle grid autoplay
4. Hover any video to play it with sound
5. Click the icon again (or the **Close** button) to return to the normal timeline

## Permissions

| Permission | Why |
| --- | --- |
| Host access (`x.com`, `twitter.com`, `video.twimg.com`) | Read media from your timeline and load video streams |
| `webRequest` | Observe video stream URLs locally so the gallery can play videos inline. URLs stay in memory and are never transmitted. |
| `storage` | Persist your autoplay preference between sessions |

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## How it works

The content script reads tweet articles already on the page, extracts media URLs, and renders a fixed-position overlay grid. For videos, the background service worker observes `.m3u8` requests made by X's own player and forwards them to the content script, which plays them inline using [hls.js](https://github.com/video-dev/hls.js). Nothing leaves your browser.

## License

[MIT](LICENSE)
