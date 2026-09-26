export type CrawlMode = 'current-page' | 'website' | 'pattern';
export type CrawlStatus = 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
export type PageStatus = 'queued' | 'crawling' | 'completed' | 'failed' | 'skipped';
export type ImageSource = 'img-src' | 'img-current-src' | 'srcset' | 'picture' | 'lazy' | 'background' | 'og-image' | 'twitter-image';

export interface CrawlConfig {
  startUrl: string;
  mode: CrawlMode;
  pattern: string;
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  requestDelayMs: number;
  timeoutMs: number;
  retryCount: number;
  includeSrcset: boolean;
  includeLazyImages: boolean;
  includeBackgroundImages: boolean;
  includeMetaImages: boolean;
  renderDynamicContent: boolean;
  respectRobotsTxt: boolean;
}

export interface CrawlJob extends CrawlConfig {
  id: string;
  status: CrawlStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CrawledPage {
  id: string;
  jobId: string;
  url: string;
  depth: number;
  status: PageStatus;
  discoveredFrom?: string;
  imageCount: number;
  linkCount: number;
  statusCode?: number;
  error?: string;
  crawledAt?: number;
}

export interface ExtractedImage {
  url: string;
  discoveredFrom: ImageSource;
  alt?: string;
  title?: string;
  width?: number;
  height?: number;
  contexts?: ImageContext[];
}

export interface ImageContext {
  pageUrl: string;
  section?: string;
  heading?: string;
  selector?: string;
}

export interface CrawledImage extends ExtractedImage {
  id: string;
  jobId: string;
  filename: string;
  sourcePages: string[];
  sourceContexts: ImageContext[];
  status: 'discovered' | 'downloading' | 'downloaded' | 'failed';
  mimeType?: string;
  fileSize?: number;
  error?: string;
  discoveredAt: number;
}

export interface CrawlError {
  id: string;
  jobId: string;
  type: 'NETWORK' | 'TIMEOUT' | 'HTTP' | 'PARSER' | 'DOWNLOAD' | 'PERMISSION' | 'UNKNOWN';
  url: string;
  message: string;
  statusCode?: number;
  retryCount: number;
  createdAt: number;
}

export interface PageScanResult {
  pageUrl: string;
  images: ExtractedImage[];
  links: string[];
  scannedAt: number;
}

export const DEFAULT_CONFIG: CrawlConfig = {
  startUrl: 'https://vju.ac.vn/',
  mode: 'website',
  pattern: 'https://vju.ac.vn/*',
  maxPages: 500,
  maxDepth: 10,
  concurrency: 2,
  requestDelayMs: 500,
  timeoutMs: 20_000,
  retryCount: 2,
  includeSrcset: true,
  includeLazyImages: true,
  includeBackgroundImages: true,
  includeMetaImages: true,
  renderDynamicContent: true,
  respectRobotsTxt: true
};

const TRACKING = /^(utm_[a-z]+|fbclid|gclid)$/i;

export function normalizeUrl(input: string, base?: string): string {
  const url = new URL(input, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL phải dùng HTTP hoặc HTTPS');
  url.hash = '';
  const queryKeys: string[] = []; url.searchParams.forEach((_value, key) => queryKeys.push(key));
  for (const key of queryKeys) if (TRACKING.test(key)) url.searchParams.delete(key);
  return url.toString();
}

export function isAllowedPage(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && url.hostname === 'vju.ac.vn';
  } catch { return false; }
}

export function normalizePageUrl(input: string, base?: string): string {
  const url = new URL(normalizeUrl(input, base));
  if (url.pathname !== '/' && !url.pathname.endsWith('/') && !/\.[a-z0-9]{1,8}$/i.test(url.pathname)) url.pathname += '/';
  return url.toString();
}

export function matchesPattern(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
}

export function filenameFromUrl(input: string): string {
  const path = new URL(input).pathname;
  let name = decodeURIComponent(path.split('/').pop() || '');
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 140);
  return name || 'image';
}

export function uniqueFilename(input: string, existing: Set<string>): string {
  const dot = input.lastIndexOf('.');
  const stem = dot > 0 ? input.slice(0, dot) : input;
  const ext = dot > 0 ? input.slice(dot) : '';
  let filename = input;
  let index = 2;
  while (existing.has(filename.toLowerCase())) filename = `${stem}-${index++}${ext}`;
  existing.add(filename.toLowerCase());
  return filename;
}

export function validateConfig(value: CrawlConfig): CrawlConfig {
  const startUrl = normalizePageUrl(value.startUrl);
  if (!isAllowedPage(startUrl)) throw new Error('Chỉ crawl https://vju.ac.vn/');
  if (!Number.isInteger(value.maxPages) || value.maxPages < 1 || value.maxPages > 5000) throw new Error('Max pages: 1–5000');
  if (!Number.isInteger(value.maxDepth) || value.maxDepth < 0 || value.maxDepth > 30) throw new Error('Max depth: 0–30');
  if (![1, 2, 3, 5].includes(value.concurrency)) throw new Error('Concurrency: 1, 2, 3 hoặc 5');
  if (![0, 250, 500, 1000, 2000].includes(value.requestDelayMs)) throw new Error('Delay không hợp lệ');
  if (!Number.isInteger(value.retryCount) || value.retryCount < 0 || value.retryCount > 5) throw new Error('Retry: 0–5');
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 60000) throw new Error('Timeout: 1–60 giây');
  if (value.mode === 'pattern' && (!value.pattern || !value.pattern.startsWith('https://vju.ac.vn/'))) throw new Error('Pattern phải bắt đầu bằng https://vju.ac.vn/');
  return { ...value, startUrl };
}
