#!/usr/bin/env node

/*
 * Rendered UI crawler for WordPress (and other same-origin sites).
 *
 * Unlike the extension crawler, this runs a real Chromium page. The export is
 * intended to be a hand-off to a redesign/rebuild: screenshots show the
 * result, rendered HTML shows the actual DOM, and page.json records layout,
 * styles, responsive differences, interactions and downloaded assets.
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const DEFAULTS = {
  maxPages: 50,
  maxDepth: 3,
  timeout: 30_000,
  out: 'ui-export',
  mobile: true,
  respectRobots: true,
  includeJs: false,
};

function parseArgs(argv) {
  const result = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--help' || value === '-h') {
      process.stdout.write('Usage: npm run crawl:ui -- --url <url> [--max-pages 50] [--max-depth 3] [--out ui-export] [--no-mobile] [--ignore-robots] [--include-js]\n');
      process.exit(0);
    }
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    if (key === 'no-mobile' || key === 'ignore-robots' || key === 'include-js') {
      result[{ 'no-mobile': 'mobile', 'ignore-robots': 'respectRobots', 'include-js': 'includeJs' }[key]] = false;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`Thiếu giá trị cho --${key}`);
    i += 1;
    if (key === 'url') result.url = next;
    else if (key === 'out') result.out = next;
    else if (key === 'max-pages') result.maxPages = integer(next, 1, 5000, '--max-pages');
    else if (key === 'max-depth') result.maxDepth = integer(next, 0, 30, '--max-depth');
    else if (key === 'timeout') result.timeout = integer(next, 1000, 120_000, '--timeout');
    else throw new Error(`Tùy chọn không được hỗ trợ: --${key}`);
  }
  if (!result.url) throw new Error('Cần --url, ví dụ: --url https://vju.ac.vn/');
  result.url = normalizePageUrl(result.url);
  return result;
}

function integer(value, min, max, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} phải nằm trong khoảng ${min}-${max}`);
  return parsed;
}

function normalizePageUrl(input, base) {
  const url = new URL(input, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Chỉ hỗ trợ HTTP/HTTPS');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  return url.toString();
}

function sameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch { return false; }
}

function isPageUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return !/\.(?:css|js|json|xml|txt|pdf|zip|rar|7z|jpe?g|png|gif|webp|svg|ico|woff2?|ttf|eot|mp4|webm|mp3|wav)$/i.test(parsed.pathname);
  } catch { return false; }
}

function hash(value) { return crypto.createHash('sha1').update(value).digest('hex').slice(0, 10); }

function slug(value) {
  const parsed = new URL(value);
  const name = `${parsed.hostname}${parsed.pathname === '/' ? '-home' : parsed.pathname}`
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 70) || 'page';
  return `${name}-${hash(value)}`;
}

async function ensureDirectory(directory) { await fs.mkdir(directory, { recursive: true }); }

async function writeJson(file, value) {
  await ensureDirectory(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readText(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return undefined;
    return await response.text();
  } catch { return undefined; } finally { clearTimeout(timer); }
}

function robotsPolicy(text, userAgent = '*') {
  if (!text) return () => true;
  const groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') { current = { agents: [value.toLowerCase()], disallow: [] }; groups.push(current); }
    else if (key === 'disallow' && current && value) current.disallow.push(value);
  }
  const applicable = groups.filter((group) => group.agents.includes('*') || group.agents.includes(userAgent.toLowerCase()));
  const disallow = applicable.flatMap((group) => group.disallow);
  return (url) => { try { return !disallow.some((prefix) => new URL(url).pathname.startsWith(prefix)); } catch { return false; } };
}

async function discoverSitemapUrls(origin, robotsText, timeout) {
  const candidates = [];
  for (const line of robotsText?.split(/\r?\n/) || []) {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (match) candidates.push(match[1]);
  }
  candidates.push(`${origin}/wp-sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap.xml`);
  const visited = new Set();
  const urls = new Set();
  const visit = async (sitemap, depth = 0) => {
    if (depth > 2 || visited.has(sitemap) || !sameOrigin(sitemap, origin)) return;
    visited.add(sitemap);
    const xml = await readText(sitemap, timeout);
    if (!xml) return;
    const sitemapIndex = /<sitemapindex\b/i.test(xml);
    for (const match of xml.matchAll(/<loc[^>]*>\s*([^<]+?)\s*<\/loc>/gi)) {
      const location = match[1].trim();
      if (sitemapIndex || /sitemap(?:[_-]index)?\.xml/i.test(location)) await visit(location, depth + 1);
      else if (sameOrigin(location, origin) && isPageUrl(location)) urls.add(normalizePageUrl(location));
    }
  };
  for (const candidate of [...new Set(candidates)]) await visit(candidate);
  return [...urls];
}

function snapshotPage() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x + scrollX), y: Math.round(box.y + scrollY), width: Math.round(box.width), height: Math.round(box.height) };
  };
  const selector = (element) => {
    if (!(element instanceof Element)) return '';
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.classList.length) part += `.${[...current.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.')}`;
      const siblings = current.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const styles = (element) => {
    const value = getComputedStyle(element);
    const properties = ['display', 'position', 'width', 'height', 'margin', 'padding', 'gap', 'color', 'backgroundColor', 'backgroundImage', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'border', 'borderRadius', 'boxShadow', 'opacity', 'zIndex', 'alignItems', 'justifyContent', 'gridTemplateColumns', 'flexDirection'];
    return Object.fromEntries(properties.map((property) => [property, value[property]]).filter(([, item]) => item));
  };
  const compactText = (value) => (value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const elementSummary = (element) => ({
    selector: selector(element), tag: element.tagName.toLowerCase(), id: element.id || undefined,
    classes: [...element.classList].slice(0, 10), text: compactText(element.textContent),
    rect: rect(element), styles: styles(element), visible: visible(element),
  });
  const componentSelectors = ['header', 'nav', 'main', 'aside', 'section', 'article', 'footer', 'form', 'button', '[role="dialog"]', '[role="banner"]', '[role="navigation"]'];
  const components = [...document.querySelectorAll(componentSelectors.join(','))].filter(visible).slice(0, 300).map(elementSummary);
  const representatives = ['body', 'header', 'nav', 'main', 'footer', 'h1', 'h2', 'h3', 'p', 'a', 'button', 'input', 'img', 'section', 'article'];
  const representativeStyles = Object.fromEntries(representatives.map((name) => [name, document.querySelector(name) ? styles(document.querySelector(name)) : undefined]).filter(([, value]) => value));
  const variables = Object.fromEntries([...getComputedStyle(document.documentElement)].filter((name) => name.startsWith('--')).map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()]));
  const interactionElements = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[aria-expanded],[data-toggle],[data-target]')].slice(0, 500).map((element) => ({
    selector: selector(element), tag: element.tagName.toLowerCase(), text: compactText(element.textContent || element.getAttribute('aria-label')),
    href: element instanceof HTMLAnchorElement ? element.href : undefined, type: element.getAttribute('type') || undefined,
    role: element.getAttribute('role') || undefined, ariaExpanded: element.getAttribute('aria-expanded') || undefined,
    disabled: element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.disabled : undefined,
    rect: rect(element), visible: visible(element),
  }));
  const links = [...document.querySelectorAll('a[href]')].map((element) => element.href).filter(Boolean);
  const meta = Object.fromEntries([...document.querySelectorAll('meta[name],meta[property]')].map((element) => [element.getAttribute('name') || element.getAttribute('property'), element.getAttribute('content') || '']).filter(([name]) => name));
  return {
    title: document.title, lang: document.documentElement.lang || undefined, bodyClasses: [...document.body?.classList || []],
    meta, canonical: document.querySelector('link[rel="canonical"]')?.href,
    wordpress: { generator: document.querySelector('meta[name="generator"]')?.content, markers: Boolean(document.querySelector('[class*="wp-"],link[href*="/wp-content/"],script[src*="/wp-includes/"]')) },
    dimensions: { viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight },
    designTokens: variables, representativeStyles, components, interactions: interactionElements, links, regions: components.filter((item) => ['header', 'nav', 'main', 'footer', 'section'].includes(item.tag)),
  };
}

function assetExtension(url, contentType) {
  const pathname = new URL(url).pathname;
  const fromUrl = path.extname(pathname).split('?')[0].toLowerCase();
  if (fromUrl && fromUrl.length < 8) return fromUrl;
  const map = { 'text/css': '.css', 'image/svg+xml': '.svg', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'font/woff2': '.woff2', 'font/woff': '.woff', 'application/font-woff': '.woff', 'application/javascript': '.js', 'text/javascript': '.js' };
  return map[contentType.split(';')[0].trim().toLowerCase()] || '';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const start = new URL(options.url);
  const origin = start.origin;
  const output = path.resolve(options.out);
  await ensureDirectory(output);
  const robotsText = options.respectRobots ? await readText(`${origin}/robots.txt`, options.timeout) : undefined;
  const allowedByRobots = robotsPolicy(robotsText);
  const sitemapUrls = await discoverSitemapUrls(origin, robotsText, options.timeout);
  const queue = [{ url: options.url, depth: 0 }];
  const queued = new Set([options.url]);
  for (const sitemapUrl of sitemapUrls) {
    if (options.maxDepth < 1 || queued.size >= options.maxPages || queued.has(sitemapUrl) || !allowedByRobots(sitemapUrl)) continue;
    queued.add(sitemapUrl);
    queue.push({ url: sitemapUrl, depth: 1, discoveredFrom: 'sitemap' });
  }
  const pages = [];
  const assets = new Map();
  let currentPageAssets = new Set();
  const browser = await chromium.launch({ headless: true });
  const contexts = [{ name: 'desktop', viewport: { width: 1440, height: 1000 } }];
  if (options.mobile) contexts.push({ name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true });
  const context = await browser.newContext({ viewport: contexts[0].viewport, deviceScaleFactor: 1, ignoreHTTPSErrors: true, locale: 'vi-VN' });
  const page = await context.newPage();
  const pendingAssets = new Set();
  const captureAsset = async (response) => {
    const url = response.url();
    if (!/^https?:\/\//i.test(url)) return;
    if (assets.has(url)) { currentPageAssets.add(url); return; }
    const type = (response.headers()['content-type'] || '').toLowerCase();
    const isAsset = type.startsWith('image/') || type.startsWith('font/') || type.includes('woff') || type === 'text/css' || (options.includeJs && (type.includes('javascript') || type.includes('ecmascript')));
    if (!isAsset) return;
    const task = (async () => {
      try {
        const body = await response.body();
        if (body.length > 25 * 1024 * 1024) return;
        const extension = assetExtension(url, type);
        const originalName = path.basename(new URL(url).pathname).replace(/[^a-z0-9._-]/gi, '_').slice(-90) || 'asset';
        const filename = `${hash(url)}-${originalName.toLowerCase().endsWith(extension) ? originalName : `${originalName}${extension}`}`;
        const relative = path.join('assets', filename);
        await ensureDirectory(path.dirname(path.join(output, relative)));
        await fs.writeFile(path.join(output, relative), body);
        assets.set(url, { url, type, file: relative.replaceAll('\\', '/'), bytes: body.length });
        currentPageAssets.add(url);
      } catch { /* a cache, CORS or detached response can make body unavailable */ }
    })();
    pendingAssets.add(task); await task; pendingAssets.delete(task);
  };
  page.on('response', (response) => { void captureAsset(response); });

  try {
    while (queue.length && pages.length < options.maxPages) {
      const item = queue.shift();
      if (!item || !allowedByRobots(item.url)) continue;
      const pageId = slug(item.url);
      const pageDir = path.join(output, 'pages', pageId);
      await ensureDirectory(pageDir);
      const captures = {};
      currentPageAssets = new Set();
      let firstSnapshot;
      try {
        for (const viewport of contexts) {
          await page.setViewportSize(viewport.viewport);
          const response = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: options.timeout });
          await page.waitForTimeout(800);
          await page.evaluate(async () => {
            if (document.fonts?.ready) await document.fonts.ready;
            const max = Math.min(document.body?.scrollHeight || 0, 30_000);
            for (let y = 0; y < max; y += Math.max(innerHeight * 0.85, 500)) { scrollTo(0, y); await new Promise((resolve) => setTimeout(resolve, 80)); }
            scrollTo(0, 0); await new Promise((resolve) => setTimeout(resolve, 250));
          });
          const snapshot = await page.evaluate(snapshotPage);
          const prefix = path.join(pageDir, viewport.name);
          await page.screenshot({ path: `${prefix}.full.png`, fullPage: true });
          await page.screenshot({ path: `${prefix}.viewport.png`, fullPage: false });
          await fs.writeFile(`${prefix}.html`, await page.content(), 'utf8');
          captures[viewport.name] = { ...snapshot, status: response?.status(), screenshot: { fullPage: `${path.relative(output, `${prefix}.full.png`).replaceAll('\\', '/')}`, viewport: `${path.relative(output, `${prefix}.viewport.png`).replaceAll('\\', '/')}` }, html: `${path.relative(output, `${prefix}.html`).replaceAll('\\', '/')}` };
          if (!firstSnapshot) firstSnapshot = snapshot;
        }
        await Promise.allSettled([...pendingAssets]);
        const record = { id: pageId, url: item.url, depth: item.depth, crawledAt: new Date().toISOString(), desktop: captures.desktop, mobile: captures.mobile, assets: [...currentPageAssets].map((assetUrl) => assets.get(assetUrl)).filter(Boolean), discoveredFrom: item.discoveredFrom };
        await writeJson(path.join(pageDir, 'page.json'), record);
        pages.push(record);
        for (const raw of firstSnapshot?.links || []) {
          let next;
          try { next = normalizePageUrl(raw, item.url); } catch { continue; }
          if (sameOrigin(next, origin) && isPageUrl(next) && !queued.has(next) && item.depth < options.maxDepth && queued.size < options.maxPages) { queued.add(next); queue.push({ url: next, depth: item.depth + 1, discoveredFrom: item.url }); }
        }
      } catch (error) {
        const failure = { id: pageId, url: item.url, depth: item.depth, status: 'failed', error: error instanceof Error ? error.message : String(error) };
        await writeJson(path.join(pageDir, 'page.json'), failure); pages.push(failure);
      }
      process.stdout.write(`\rĐã crawl ${pages.length}/${options.maxPages}: ${item.url}`);
    }
  } finally {
    await Promise.allSettled([...pendingAssets]);
    await context.close();
    await browser.close();
  }
  const manifest = { version: 1, tool: 'vju-ui-crawler', createdAt: new Date().toISOString(), source: { startUrl: options.url, origin, wordpress: pages.some((item) => item.desktop?.wordpress?.markers), robotsRespected: options.respectRobots }, options, sitemapUrls, pages: pages.map((item) => ({ id: item.id, url: item.url, depth: item.depth, status: item.status || 'completed', directory: `pages/${item.id}` })), assets: [...assets.values()] };
  await writeJson(path.join(output, 'manifest.json'), manifest);
  await fs.writeFile(path.join(output, 'README.md'), `# Rendered UI export\n\n- Source: ${options.url}\n- Pages: ${pages.length}\n- Assets: ${assets.size}\n- Each page contains desktop/mobile screenshots, rendered HTML and \`page.json\`.\n- \`page.json\` includes layout boxes, representative computed styles, CSS variables, forms/buttons/links and WordPress markers.\n\nOpen \`manifest.json\` first when importing this export into a new application.\n`, 'utf8');
  process.stdout.write(`\nHoàn tất: ${pages.length} page(s), ${assets.size} asset(s) -> ${output}\n`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
