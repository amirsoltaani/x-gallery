# Privacy Policy for X Gallery View

**Last updated:** April 26, 2026

## Data Collection

X Gallery View does **not** collect, store, transmit, or share any user data. The extension operates entirely within your browser.

## How It Works

The extension reads media (images and video thumbnails) from tweets visible on your X/Twitter timeline and displays them in a local gallery overlay. All processing happens locally in your browser. No data is sent to any external server.

## Permissions

- **Host permissions (x.com, twitter.com, video.twimg.com):** Required to run the content script that extracts media from your timeline and displays the gallery overlay, and to load video streams for inline playback.
- **webRequest:** Used locally to observe video stream URLs (.m3u8) requested by X's own video player so the gallery can play those videos inline. URLs are kept in memory only and never sent anywhere.
- **storage:** Used locally via `chrome.storage.local` to remember your autoplay preference (Off/On) between sessions. No personal data is stored.

## Third-Party Services

This extension does not communicate with any third-party services or APIs. Video streams are loaded directly from X's own CDN (video.twimg.com), the same source the X website uses.

## Changes

If this policy changes, updates will be posted here.

## Contact

If you have questions, open an issue at https://github.com/amirsoltaani/x-gallery/issues
