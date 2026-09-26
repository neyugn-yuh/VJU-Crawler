import { parseHTML } from 'linkedom';
import { extractFromDocument } from './extractor';
import { count, get, list, put } from './db';
import { DEFAULT_CONFIG, filenameFromUrl, isAllowedPage, matchesPattern, normalizePageUrl, normalizeUrl, uniqueFilename, validateConfig, type CrawlConfig, type CrawlError, type CrawledImage, type CrawledPage, type CrawlJob, type ExtractedImage, type PageScanResult } from './shared';

const running = new Map<string, { paused: boolean; stopped: boolean; controllers: Set<AbortController> }>();
const notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function id(prefix: string) { return `${prefix}_${crypto.randomUUID()}`; }

async function emitProgress(jobId: string) {
  const job = await get<CrawlJob>('jobs', jobId);
  if (!job) return;
  const [pageCount, imageCount, errorCount] = await Promise.all([
    count('pages', jobId),
    count('images', jobId),
    count('errors', jobId),
  ]);
  chrome.runtime.sendMessage({ type: 'PROGRESS', payload: { job, pageCount, imageCount, errorCount } }).catch(() => undefined);
}

function notify(jobId: string) {
  if (notifyTimers.has(jobId)) return;
  const timer = setTimeout(() => {
    notifyTimers.delete(jobId);
    void emitProgress(jobId);
  }, 150);
  notifyTimers.set(jobId, timer);
}

async function saveImage(job: CrawlJob, image: ExtractedImage, pageUrl: string, filenames: Set<string>) {
  let normalizedUrl: string;
  try { normalizedUrl = normalizeUrl(image.url); } catch { return; }
  const existing = (await list<CrawledImage>('images', job.id)).find((item) => item.url === normalizedUrl);
  if (existing) {
    const contexts = image.contexts || [{ pageUrl }];
    const known = existing.sourceContexts || [];
    const additions = contexts.filter((context) => !known.some((item) => item.pageUrl === context.pageUrl && item.selector === context.selector && item.section === context.section));
    if (!existing.sourcePages.includes(pageUrl) || additions.length) { existing.sourcePages = [...new Set([...existing.sourcePages, pageUrl])]; existing.sourceContexts = [...known, ...additions]; await put('images', existing); }
    return;
  }
  const original = filenameFromUrl(normalizedUrl);
  const filename = uniqueFilename(original, filenames);
  await put('images', { ...image, id: id('img'), jobId: job.id, url: normalizedUrl, filename, sourcePages: [pageUrl], sourceContexts: image.contexts || [{ pageUrl }], status: 'discovered', discoveredAt: Date.now() });
}

async function saveScan(job: CrawlJob, scan: PageScanResult, page: CrawledPage, filenames: Set<string>) {
  for (const image of scan.images) await saveImage(job, image, scan.pageUrl, filenames);
  page.status = 'completed'; page.imageCount = scan.images.length; page.linkCount = scan.links.length; page.crawledAt = Date.now(); await put('pages', page);
  return scan.links;
}

async function fetchWithRetry(url: string, job: CrawlJob, control?: { controllers: Set<AbortController> }): Promise<{ html: string; status: number }> {
  let last: unknown;
  for (let attempt = 0; attempt <= job.retryCount; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, Math.min(3000, 500 * 2 ** (attempt - 1))));
    const controller = new AbortController();
    control?.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), job.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml' } });
      if (!response.ok && ![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { html: await response.text(), status: response.status };
    } catch (error) { last = error; if (control && running.get(job.id)?.stopped) throw error; } finally { clearTimeout(timeout); control?.controllers.delete(controller); }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function crawlWebsite(job: CrawlJob) {
  const control = running.get(job.id)!;
  const queue: Array<{ url: string; depth: number; discoveredFrom?: string }> = [{ url: job.startUrl, depth: 0 }];
  const queued = new Set([job.startUrl]);
  const filenames = new Set<string>();
  const robots = job.respectRobotsTxt ? await fetchRobots(job.startUrl) : undefined;
  let active = 0;
  const process = async (item: { url: string; depth: number; discoveredFrom?: string }) => {
    active++;
    if (await list<CrawledPage>('pages', job.id).then((pages) => pages.some((page) => page.url === item.url))) { active--; return; }
    const page: CrawledPage = { id: id('page'), jobId: job.id, url: item.url, depth: item.depth, status: 'crawling', discoveredFrom: item.discoveredFrom, imageCount: 0, linkCount: 0 };
    await put('pages', page); await notify(job.id);
    try {
      if (robots && !robots(item.url)) throw new Error('robots.txt disallow');
      const result = await fetchWithRetry(item.url, job, control);
      const { document } = parseHTML(result.html);
      const scan = extractFromDocument(document as unknown as Document, item.url, { srcset: job.includeSrcset, lazy: job.includeLazyImages, background: job.includeBackgroundImages, meta: job.includeMetaImages });
      const links = await saveScan(job, scan, { ...page, statusCode: result.status }, filenames);
      if (job.mode !== 'current-page' && item.depth < job.maxDepth) for (const raw of links) {
        let link: string;
        try { link = normalizePageUrl(raw, item.url); } catch { continue; }
        if (!isAllowedPage(link) || queued.has(link) || (job.mode === 'pattern' && !matchesPattern(link, job.pattern))) continue;
        if (queued.size >= job.maxPages) break;
        queued.add(link); queue.push({ url: link, depth: item.depth + 1, discoveredFrom: item.url });
      }
    } catch (error) {
      page.status = 'failed'; page.error = error instanceof Error ? error.message : String(error); await put('pages', page);
      await put('errors', { id: id('err'), jobId: job.id, type: page.error.includes('abort') ? 'TIMEOUT' : page.error.startsWith('HTTP') ? 'HTTP' : 'NETWORK', url: item.url, message: page.error, retryCount: job.retryCount, createdAt: Date.now() });
    }
    await notify(job.id);
    active--;
  };
  const worker = async () => {
    while (!control.stopped) {
      if (control.paused) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
      const item = queue.shift();
      if (item) { await process(item); if (job.requestDelayMs) await new Promise((resolve) => setTimeout(resolve, job.requestDelayMs)); continue; }
      if (active === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  };
  await Promise.all(Array.from({ length: job.concurrency }, worker));
  job.status = control.stopped ? 'stopped' : 'completed'; job.updatedAt = Date.now(); job.completedAt = Date.now(); await put('jobs', job); await notify(job.id); running.delete(job.id);
}

async function fetchRobots(startUrl: string): Promise<((url: string) => boolean) | undefined> {
  try {
    const origin = new URL(startUrl).origin;
    const text = await (await fetch(`${origin}/robots.txt`)).text();
    const disallow: string[] = []; let applies = false;
    for (const raw of text.split(/\r?\n/)) { const line = raw.split('#')[0].trim(); const [key, ...values] = line.split(':'); if (key?.toLowerCase() === 'user-agent') applies = values.join(':').trim() === '*' ; if (applies && key?.toLowerCase() === 'disallow' && values.join(':').trim()) disallow.push(values.join(':').trim()); }
    return (url) => { const path = new URL(url).pathname; return !disallow.some((prefix) => path.startsWith(prefix)); };
  } catch { return undefined; }
}

async function startCrawl(config: CrawlConfig, tabId?: number): Promise<CrawlJob> {
  const value = validateConfig(config);
  const job: CrawlJob = { ...value, id: id('crawl'), status: 'running', createdAt: Date.now(), updatedAt: Date.now() };
  await put('jobs', job); running.set(job.id, { paused: false, stopped: false, controllers: new Set() });
  if (value.mode === 'current-page' && tabId !== undefined) {
    const options = { srcset: value.includeSrcset, lazy: value.includeLazyImages, background: value.includeBackgroundImages, meta: value.includeMetaImages };
    chrome.tabs.sendMessage(tabId, { type: value.renderDynamicContent ? 'SCROLL_SCAN' : 'SCAN_PAGE', options }, async (scan?: PageScanResult) => {
      const control = running.get(job.id);
      if (control?.stopped) { running.delete(job.id); return; }
      if (chrome.runtime.lastError || !scan) { job.status = 'failed'; await put('jobs', job); await notify(job.id); return; }
      const filenames = new Set<string>(); const page: CrawledPage = { id: id('page'), jobId: job.id, url: scan.pageUrl, depth: 0, status: 'crawling', imageCount: 0, linkCount: 0 };
      await put('pages', page); await saveScan(job, scan, page, filenames); job.status = 'completed'; job.updatedAt = Date.now(); job.completedAt = Date.now(); await put('jobs', job); await notify(job.id); running.delete(job.id);
    });
  } else void crawlWebsite(job);
  return job;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'START_CRAWL') sendResponse({ ok: true, job: await startCrawl(message.config, sender.tab?.id ?? message.tabId) });
      else if (message.type === 'CONTROL_CRAWL') { const control = running.get(message.id); if (control) { control.paused = message.action === 'pause' ? true : message.action === 'resume' ? false : control.paused; control.stopped = message.action === 'stop'; if (control.stopped) for (const controller of control.controllers) controller.abort(); } const job = await get<CrawlJob>('jobs', message.id); if (job) { job.status = message.action === 'pause' ? 'paused' : message.action === 'resume' ? 'running' : 'stopped'; job.updatedAt = Date.now(); await put('jobs', job); await notify(job.id); } sendResponse({ ok: true }); }
      else if (message.type === 'GET_STATE') {
        const jobs = await list<CrawlJob>('jobs');
        const selected = message.id || jobs.at(-1)?.id;
        let pages: CrawledPage[] = [];
        let images: CrawledImage[] = [];
        let errors: CrawlError[] = [];
        let pageCount = 0;
        let imageCount = 0;
        let errorCount = 0;
        if (selected) {
          [pageCount, imageCount, errorCount] = await Promise.all([count('pages', selected), count('images', selected), count('errors', selected)]);
          if (message.detail === true) [pages, images, errors] = await Promise.all([
            list<CrawledPage>('pages', selected).then((items) => items.map(({ html, ...page }) => page)),
            list<CrawledImage>('images', selected),
            list<CrawlError>('errors', selected),
          ]);
        }
        sendResponse({ jobs, job: selected ? jobs.find((job) => job.id === selected) : undefined, pages, images, errors, pageCount, imageCount, errorCount });
      }
      else if (message.type === 'DELETE_JOB') { const { removeJob } = await import('./db'); await removeJob(message.id); sendResponse({ ok: true }); }
      else sendResponse({ ok: false, error: 'Unknown message' });
    } catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  })(); return true;
});

chrome.runtime.onMessage.addListener((message) => { if (message.type === 'PAGE_SCAN_RESULT') void notify(message.payload?.jobId || ''); });
