/**
 * v3 Phase 6 fixture #7 — infinite scroll.
 *
 * Acceptance target: step counter + no-progress detector under canvas-like
 * change. Each scroll appends a new `<div>` to a tall container, so the
 * pHash varies between steps (page actually moves under the cursor); ARIA
 * tree also gains nodes. This proves that legitimate "page is changing"
 * workflows do NOT trigger the no-progress fallback abort, while a session
 * that keeps scrolling without bound eventually trips `maxSteps`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const FIXTURE_HOST = 'scroll.fixture.local'

// The page renders 60 visually distinct posts in a column tall enough that
// each `mouse.wheel(0, 600)` scrolls past several. A fixed-position counter
// (top-left corner; visible regardless of scroll) updates on every scroll
// event so the *viewport's* pixels change with every action — not just the
// off-screen content. This is the load-bearing property: the no-progress
// detector compares pHashes of the *visible* viewport, so a fixture whose
// viewport stays mostly empty would false-positive abort even though the
// page is "scrolling."
const POSTS = Array.from({ length: 60 }, (_, i) => {
  const hue = (i * 37) % 360
  return `<article aria-label="Post ${i}" style="background:hsl(${hue},70%,80%);padding:24px;margin:8px;font-size:24px;">Post ${i}</article>`
}).join('\n')

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>infinite scroll</title></head>
<body style="margin:0">
  <div id="counter" aria-label="Scroll counter"
    style="position:fixed;top:0;left:0;background:black;color:white;padding:16px 24px;font-size:32px;z-index:99;">scroll:0</div>
  <h1>Infinite scroll</h1>
  <div id="feed" style="display:flex;flex-direction:column;">
    ${POSTS}
  </div>
  <script>
    let scrollCounter = 0;
    window.addEventListener('scroll', () => {
      scrollCounter += 1;
      document.title = 'scroll:' + scrollCounter;
      document.getElementById('counter').textContent = 'scroll:' + scrollCounter;
    });
  </script>
</body>
</html>`

export function infiniteScrollHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-type', 'text/html')
  res.end(PAGE_HTML)
}
