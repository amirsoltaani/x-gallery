X Gallery View turns your X (Twitter) timeline into a media-first gallery. Click the
extension icon and the page flips into a clean grid of every image and video from the
tweets you've loaded. Click again to go back to the normal timeline.

FEATURES

• One-click toggle — Switch between the regular timeline and the gallery view from the
  toolbar icon (or press Ctrl+Shift+G).

• Images and videos in one grid — Photos and videos sit side-by-side in a responsive
  grid, and videos can play inline right in the grid.

• Hover to preview — Hover any photo or video and it pops out at its native aspect ratio,
  so wide and tall media display correctly. Videos play with sound on hover. Move your
  mouse away and it returns to the grid.

• Full-screen viewer — Click any image or video to open a full-screen lightbox. Step
  through all your media with the on-screen arrows or your keyboard's left/right keys.
  Each item shows the author's name, their @handle (linked to their profile), and the
  post text.

• Open the original post — A "View post" link on each tile and in the viewer takes you
  straight to the tweet on X.

• One-click download — Save any image or video from the viewer. Images download at
  original resolution, and videos download with sound: X serves audio as a separate
  stream, so the extension combines the audio and video into a single MP4 right in your
  browser.

• Autoplay toggle — Choose Off or On for grid autoplay. Off is light on resources; On
  plays every visible video muted as you scroll. Your choice is remembered across
  sessions.

• Infinite scroll — As you scroll the gallery, the underlying timeline keeps loading more
  content, growing the grid.

• Works on the home timeline and profile feeds — anywhere X shows a tweet feed.

PRIVACY

X Gallery View does not collect, transmit, or share any data. Everything happens locally
in your browser — including downloads, which are assembled on your machine. Media comes
from X's own CDN, the same source the X website uses. Your autoplay preference is stored
locally via Chrome's storage API. Nothing leaves your machine.

PERMISSIONS

• Host access to x.com, twitter.com, and video.twimg.com — required to read media from
  your timeline and load video streams for inline playback and downloads.
• webRequest — used locally to observe the video stream URLs (.m3u8) that X's own player
  requests, so the gallery can play and download them. URLs stay in memory and are never
  transmitted.
• storage — used to remember your autoplay preference between sessions.

OPEN SOURCE

Source code, issues, and contributions: https://github.com/amirsoltaani/x-gallery
