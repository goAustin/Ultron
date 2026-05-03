/**
 * v3 Phase 6 fixture #9 — slow-loading page.
 *
 * Acceptance target: stabilization handles a multi-second delay without
 * flaking; navigation completes once the page lands; the step counter is
 * unaffected by stabilization wait time (clock-time, not action-count).
 *
 * Exported as a factory so tests can pick a delay (default 3000ms — short
 * enough to keep the suite fast; configurable via the integration test's
 * `SLOW_LOAD_DELAY_MS` env var if needed).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const FIXTURE_HOST = 'slow.fixture.local'

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>slow-loaded</title></head>
<body style="margin:0">
  <h1>Done</h1>
  <p>This page took a while to respond.</p>
  <button id="ack" aria-label="Acknowledge">Acknowledge</button>
  <script>
    document.getElementById('ack').addEventListener('click', () => {
      document.title = 'acknowledged';
    });
  </script>
</body>
</html>`

export type SlowLoadHandlerOpts = {
  /** Milliseconds the server delays before sending response headers. */
  readonly delayMs: number
}

export function makeSlowLoadHandler(
  opts: SlowLoadHandlerOpts,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    setTimeout(() => {
      res.setHeader('content-type', 'text/html')
      res.end(PAGE_HTML)
    }, opts.delayMs)
  }
}

/**
 * v3 Phase 6 PR3 — handler that COMMITS the navigation immediately (flushes
 * headers + a partial HTML prefix so Playwright's `page.goto(... waitUntil:
 * 'commit')` resolves) but never closes the response body. With the body
 * held open, `domcontentloaded` and `load` never fire, so any caller that
 * follows `goto` with a stabilization step (`stabilize.ts` step 2 — wait
 * for `domcontentloaded`) will block until aborted.
 *
 * Used by the abort-during-stabilize failure-recovery test — the plain
 * `makeSlowLoadHandler` delays before sending headers, so abort there
 * surfaces during `goto`, not during `stabilize`.
 */
export function makeStabilizeHungHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
) => void {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    // Send enough bytes that Playwright's `commit` event fires (the parser
    // has seen the doctype + opening tags), but stop short of a complete
    // document so `domcontentloaded` cannot fire. The connection stays
    // open until the test tears down its servers.
    res.write('<!DOCTYPE html><html><head><title>stabilize-hung</title></head><body>')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
  }
}
