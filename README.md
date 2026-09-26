# VJU Image Crawler

Chrome Manifest V3 extension for scanning and crawling images on `https://vju.ac.vn/`.

## Build

```bash
npm install
npm run build
```

Load `dist/` in `chrome://extensions` with **Developer mode → Load unpacked**.

## Features

- Current page scan through content script, including dynamic DOM and lazy images.
- Same-domain website or URL-pattern crawl with depth/page limits.
- `<img>`, `srcset`, `<picture>`, lazy attributes, computed/inline backgrounds and OG/Twitter images.
- URL normalization, deduplication, safe filenames, retry, timeout, delay and robots.txt policy.
- Pause, resume, stop, crawl history and IndexedDB persistence.
- Individual image download and ZIP export with `images.json`, `pages.json`, `crawl.json` metadata.

No proxy, CAPTCHA bypass, authentication bypass or anti-bot bypass.
