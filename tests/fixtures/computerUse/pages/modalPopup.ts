/**
 * v3 Phase 6 fixture #6 — modal popup with overlay-blocked button.
 *
 * Acceptance target: the `verify.ts` `verified: false` path is exercised
 * cleanly. A "Buy" button sits behind an opaque modal overlay; clicking
 * the button's coordinates does NOT mutate the page (the overlay swallows
 * the click), so the post-action ARIA + pHash remain identical and
 * `verify.ts` returns `{ verified: false }`.
 *
 * The modal also has a Close button. After closing the modal, the same
 * click coordinates DO mutate the page (`document.title = "bought"`), so
 * a re-observation succeeds. The test asserts both branches.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const FIXTURE_HOST = 'modal.fixture.local'

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>modal</title></head>
<body style="margin:0">
  <h1>Modal demo</h1>
  <button id="buy" aria-label="Buy"
    style="position:absolute;left:480px;top:368px;width:80px;height:32px;">Buy</button>
  <div id="overlay"
    style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10;display:flex;align-items:center;justify-content:center;">
    <div role="dialog" aria-label="Notice"
      style="background:white;padding:24px;border-radius:4px;">
      <p>Please review the terms.</p>
      <button id="close" aria-label="Close dialog">Close</button>
    </div>
  </div>
  <pre id="state">none</pre>
  <script>
    document.getElementById('buy').addEventListener('click', () => {
      document.title = 'bought';
      document.getElementById('state').textContent = 'bought';
    });
    document.getElementById('close').addEventListener('click', () => {
      document.getElementById('overlay').remove();
      document.title = 'modal closed';
      document.getElementById('state').textContent = 'modal closed';
    });
  </script>
</body>
</html>`

export function modalPopupHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-type', 'text/html')
  res.end(PAGE_HTML)
}
