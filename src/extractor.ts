import type { ExtractedImage, ImageContext, ImageSource, PageScanResult } from './shared';

export interface SrcsetEntry { url: string; width?: number }

export function parseSrcset(value: string): SrcsetEntry[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [url, descriptor] = part.split(/\s+/);
    const width = descriptor?.endsWith('w') ? Number.parseInt(descriptor, 10) : undefined;
    return { url, ...(Number.isFinite(width) ? { width } : {}) };
  }).filter((entry) => entry.url);
}

function compactText(value: string | null | undefined): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 160) : undefined;
}

function selector(element: Element | null | undefined): string | undefined {
  if (!element) return undefined;
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute('id');
  const classes = (element.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
  return `${tag}${id ? `#${id}` : ''}${classes.length ? `.${classes.join('.')}` : ''}`;
}

function contextFor(element: Element | null, pageUrl: string): ImageContext {
  const container = element?.closest('section, article, main, header, footer, nav, aside, [role="region"], [role="main"], [role="banner"]') || element?.parentElement;
  const containers: Element[] = [];
  let current: Element | null | undefined = container;
  while (current) {
    containers.push(current);
    current = current.parentElement?.closest('section, article, main, header, footer, nav, aside, [role="region"], [role="main"], [role="banner"]');
  }
  const heading = containers.map((item) => item.querySelector('h1, h2, h3, h4, h5, h6')).find(Boolean);
  const headingText = compactText(heading?.textContent);
  const containerSelector = selector(container);
  const label = headingText || compactText(container?.getAttribute('aria-label')) || compactText(container?.getAttribute('data-section')) || containerSelector;
  return { pageUrl, ...(label ? { section: label } : {}), ...(headingText ? { heading: headingText } : {}), selector: containerSelector };
}

function add(images: ExtractedImage[], seen: Map<string, ExtractedImage>, raw: string | null | undefined, source: ImageSource, base: string, attrs: Partial<ExtractedImage> = {}) {
  if (!raw) return;
  try {
    const url = new URL(raw.trim(), base);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    const normalized = url.toString();
    const context = attrs.contexts?.[0];
    const existing = seen.get(normalized);
    if (existing) {
      if (context && !existing.contexts?.some((item) => item.pageUrl === context.pageUrl && item.selector === context.selector && item.section === context.section)) existing.contexts = [...(existing.contexts || []), context];
      return;
    }
    const image = { url: normalized, discoveredFrom: source, ...attrs };
    seen.set(normalized, image);
    images.push(image);
  } catch { /* malformed website value */ }
}

export function extractFromDocument(document: Document, pageUrl = document.location?.href || '', options = { srcset: true, lazy: true, background: true, meta: true }): PageScanResult {
  const images: ExtractedImage[] = [];
  const seen = new Map<string, ExtractedImage>();
  const lazyAttributes = ['data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-lazy'];
  for (const element of Array.from(document.querySelectorAll('img'))) {
    const attrs = { alt: element.getAttribute('alt') || undefined, title: element.getAttribute('title') || undefined, width: element.naturalWidth || undefined, height: element.naturalHeight || undefined, contexts: [contextFor(element, pageUrl)] };
    add(images, seen, element.getAttribute('src'), 'img-src', pageUrl, attrs);
    add(images, seen, (element as HTMLImageElement).currentSrc, 'img-current-src', pageUrl, attrs);
    if (options.srcset) for (const entry of parseSrcset(element.getAttribute('srcset') || '')) add(images, seen, entry.url, 'srcset', pageUrl, { ...attrs, width: entry.width || attrs.width });
    if (options.lazy) for (const attribute of lazyAttributes) add(images, seen, element.getAttribute(attribute), 'lazy', pageUrl, attrs);
    if (options.lazy) for (const entry of parseSrcset(element.getAttribute('data-srcset') || element.getAttribute('data-lazy-srcset') || '')) add(images, seen, entry.url, 'lazy', pageUrl, { ...attrs, width: entry.width || attrs.width });
  }
  for (const picture of Array.from(document.querySelectorAll('picture'))) {
    for (const source of Array.from(picture.querySelectorAll('source'))) {
      for (const entry of parseSrcset(source.getAttribute('srcset') || source.getAttribute('data-srcset') || '')) add(images, seen, entry.url, 'picture', pageUrl, { contexts: [contextFor(picture, pageUrl)] });
    }
  }
  if (options.background) for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element).backgroundImage : element.getAttribute('style') || '';
    for (const match of style.matchAll(/url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)/g)) add(images, seen, match[1] || match[2] || match[3], 'background', pageUrl, { contexts: [contextFor(element, pageUrl)] });
  }
  if (options.meta) for (const meta of Array.from(document.querySelectorAll('meta'))) {
    const property = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase();
    if (property === 'og:image' || property === 'og:image:url') add(images, seen, meta.getAttribute('content'), 'og-image', pageUrl, { contexts: [{ pageUrl, section: 'Open Graph metadata', selector: 'meta[property="og:image"]' }] });
    if (property === 'twitter:image' || property === 'twitter:image:src') add(images, seen, meta.getAttribute('content'), 'twitter-image', pageUrl, { contexts: [{ pageUrl, section: 'Twitter metadata', selector: 'meta[name="twitter:image"]' }] });
  }
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).flatMap((link) => {
    try { const url = new URL(link.href, pageUrl); return ['http:', 'https:'].includes(url.protocol) ? [url.toString()] : []; } catch { return []; }
  });
  return { pageUrl, images, links: [...new Set(links)], scannedAt: Date.now() };
}
