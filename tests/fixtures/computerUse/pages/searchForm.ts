/**
 * v3 Phase 6 fixture #1 — search form.
 *
 * Acceptance target: "Browser MVP succeeds on simple local form tasks."
 *
 * Single page with a `<input role="searchbox" aria-label="Search query">`
 * and a `<button>Search</button>`. On submit, the search query is reflected
 * back into `document.title` (so the test can read it via `currentTitle()`)
 * AND into a results `<div id="results">`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const FIXTURE_HOST = 'searchform.fixture.local'

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>search</title></head>
<body style="margin:0">
  <h1>Search</h1>
  <form id="f" aria-label="Search form" onsubmit="return false">
    <input id="q" aria-label="Search query" name="q" />
    <button id="go" type="submit">Search</button>
  </form>
  <div id="results"></div>
  <script>
    document.getElementById('f').addEventListener('submit', () => {
      const q = document.getElementById('q').value;
      document.title = 'results: ' + q;
      document.getElementById('results').textContent = 'Found 1 result for "' + q + '"';
    });
    document.getElementById('go').addEventListener('click', () => {
      const q = document.getElementById('q').value;
      document.title = 'results: ' + q;
      document.getElementById('results').textContent = 'Found 1 result for "' + q + '"';
    });
  </script>
</body>
</html>`

export function searchFormHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-type', 'text/html')
  res.end(PAGE_HTML)
}
