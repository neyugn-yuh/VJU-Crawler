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

## Crawl cả UI và design đã render

Image crawler chỉ phân tích HTML được tải xuống. Với WordPress, nhiều phần giao diện được tạo bởi JavaScript, CSS responsive và lazy loading nên cần render bằng trình duyệt thật. Repo này có thêm `crawl:ui`, dùng Chromium headless để tạo một gói tham chiếu cho việc dựng lại site bằng công nghệ khác.

### Cài browser và chạy

```bash
npm install
npx playwright install chromium
npm run crawl:ui -- --url https://vju.ac.vn/ --max-pages 50 --max-depth 3 --out ui-export
```

Các tùy chọn thường dùng:

- `--no-mobile`: chỉ chụp desktop (mặc định có desktop 1440px và mobile 390px).
- `--ignore-robots`: bỏ qua robots.txt khi bạn có quyền crawl site.
- `--include-js`: lưu thêm JavaScript same-origin vào thư mục assets.
- `--timeout 60000`: timeout mỗi lần mở trang, tính bằng milliseconds.

### Dữ liệu xuất ra

`ui-export/manifest.json` liệt kê toàn bộ URL, asset và thư mục của từng trang. Mỗi `pages/<id>/` gồm:

- `desktop.full.png`, `desktop.viewport.png`, `mobile.full.png`, `mobile.viewport.png`: ảnh chụp giao diện sau khi render và scroll để kích hoạt lazy content.
- `desktop.html`, `mobile.html`: DOM sau render, khác với HTML WordPress ban đầu.
- `page.json`: title, meta, canonical, marker WordPress, kích thước responsive, các vùng layout, DOM component, computed style đại diện, CSS variables, form/button/link và trạng thái ARIA.

CSS, font và ảnh đã tải được lưu trong `ui-export/assets/` và có URL gốc, MIME type, kích thước trong manifest. Đây là bộ input để chuyển từng template WordPress thành component trong React/Next/Nuxt/Laravel hoặc stack khác.

Crawler vẫn chỉ theo link cùng origin, có giới hạn page/depth, retry/timeout của Playwright và tôn trọng robots.txt mặc định. Nó không vượt qua đăng nhập, CAPTCHA hay anti-bot.
