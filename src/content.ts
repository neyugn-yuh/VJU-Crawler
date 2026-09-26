import { extractFromDocument } from './extractor';

function scan() {
  const result = extractFromDocument(document, location.href);
  chrome.runtime.sendMessage({ type: 'PAGE_SCAN_RESULT', payload: result });
}

scan();
let timer: ReturnType<typeof setTimeout> | undefined;
const observer = new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(scan, 300);
});
if (document.body) observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'data-src', 'data-srcset', 'style', 'class'] });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const options = { srcset: message.options?.srcset !== false, lazy: message.options?.lazy !== false, background: message.options?.background !== false, meta: message.options?.meta !== false };
  if (message.type === 'SCAN_PAGE') { sendResponse(extractFromDocument(document, location.href, options)); return true; }
  if (message.type === 'SCROLL_SCAN') {
    let y = 0;
    const step = Math.max(window.innerHeight, 500);
    const scroll = () => { window.scrollTo(0, y); y += step; if (y < document.body.scrollHeight) setTimeout(scroll, 80); else { window.scrollTo(0, 0); setTimeout(() => sendResponse(extractFromDocument(document, location.href, options)), 250); } };
    scroll(); return true;
  }
});
