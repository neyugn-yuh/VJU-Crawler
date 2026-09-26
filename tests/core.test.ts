import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { extractFromDocument, parseSrcset } from '../src/extractor';
import { filenameFromUrl, matchesPattern, normalizePageUrl, normalizeUrl, uniqueFilename } from '../src/shared';

describe('URL utilities', () => {
  it('normalizes hashes and tracking parameters', () => expect(normalizeUrl('https://VJU.ac.vn/a?utm_source=test&ok=1#x')).toBe('https://vju.ac.vn/a?ok=1'));
  it('normalizes page slash and patterns', () => { expect(normalizePageUrl('/news', 'https://vju.ac.vn')).toBe('https://vju.ac.vn/news/'); expect(matchesPattern('https://vju.ac.vn/news/a/', 'https://vju.ac.vn/news/*')).toBe(true); });
  it('makes safe unique filenames', () => { const used = new Set<string>(); expect(uniqueFilename(filenameFromUrl('https://vju.ac.vn/a/b.jpg?x=1'), used)).toBe('b.jpg'); expect(uniqueFilename('b.jpg', used)).toBe('b-2.jpg'); });
});

describe('image extraction', () => {
  it('extracts image variants, meta, background and links', () => {
    const { document } = parseHTML(`<html><head><meta property="og:image" content="/og.jpg"></head><body><a href="/p">p</a><img src="/a.jpg" srcset="/a-2.jpg 2x" data-src="/lazy.jpg" style="background-image:url('/ignored.jpg')"><div style="background-image:url(/bg.jpg)"></div></body></html>`);
    const result = extractFromDocument(document as unknown as Document, 'https://vju.ac.vn/');
    expect(result.images.map((image) => image.url)).toEqual(expect.arrayContaining(['https://vju.ac.vn/a.jpg', 'https://vju.ac.vn/a-2.jpg', 'https://vju.ac.vn/lazy.jpg', 'https://vju.ac.vn/og.jpg', 'https://vju.ac.vn/bg.jpg']));
    expect(result.images.find((image) => image.url.endsWith('/a.jpg'))?.contexts?.[0].selector).toBe('body');
    expect(result.images.find((image) => image.url.endsWith('/og.jpg'))?.contexts?.[0].section).toBe('Open Graph metadata');
    expect(result.links).toContain('https://vju.ac.vn/p');
  });
  it('parses srcset descriptors', () => expect(parseSrcset('a.jpg 768w, b.jpg 2x')).toEqual([{ url: 'a.jpg', width: 768 }, { url: 'b.jpg' }]));
  it('keeps semantic section context for nested cards', () => {
    const { document } = parseHTML('<section id="hero"><h2>Thông báo</h2><article class="card"><img src="/hero.jpg"></article></section>');
    const image = extractFromDocument(document as unknown as Document, 'https://vju.ac.vn/').images[0];
    expect(image.contexts?.[0]).toMatchObject({ section: 'Thông báo', selector: 'article.card' });
  });
});
