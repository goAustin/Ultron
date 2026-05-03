/**
 * v3 Phase 6 fixture #5 — dangerous-action buttons.
 *
 * Acceptance target: every dangerous label triggers the safety check at
 * risk level 3. Five buttons (Pay, Delete, Send, Confirm, Publish) all
 * match `DANGEROUS_LABEL_RE`; one decoy button ("Search") that visually
 * looks similar but has a non-dangerous label MUST classify at level ≤ 1.
 *
 * Each button updates `document.title` so a misroute (i.e. a click that
 * slips past the safety check) is detectable in tests.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const FIXTURE_HOST = 'dangerous.fixture.local'

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>dangerous</title></head>
<body style="margin:0">
  <h1>Dangerous actions</h1>
  <button id="pay" aria-label="Pay">Pay</button>
  <button id="delete" aria-label="Delete">Delete</button>
  <button id="send" aria-label="Send">Send</button>
  <button id="confirm" aria-label="Confirm">Confirm</button>
  <button id="publish" aria-label="Publish">Publish</button>
  <button id="search" aria-label="Search">Search</button>
  <pre id="state">none</pre>
  <script>
    for (const id of ['pay','delete','send','confirm','publish','search']) {
      const el = document.getElementById(id);
      el.addEventListener('click', () => {
        document.title = 'clicked:' + id;
        document.getElementById('state').textContent = 'clicked:' + id;
      });
    }
  </script>
</body>
</html>`

export function dangerousButtonsHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-type', 'text/html')
  res.end(PAGE_HTML)
}
