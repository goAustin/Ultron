/**
 * v3 Phase 6 fixture #2 — multi-step form (no submit).
 *
 * Acceptance target: DOM-first happy path across 3 steps; selector cache
 * hits on replay; verifyActions=true never trips a false stall.
 *
 * Three inputs + an internal "step" counter that updates `document.title`
 * after each fill. No submit button, so the test exercises the atom-path
 * fill action without ever touching the dangerous-action gating.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const FIXTURE_HOST = 'multistep.fixture.local'

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>multi-step</title></head>
<body style="margin:0">
  <h1>Multi-step</h1>
  <form aria-label="Multi-step form">
    <label>First name <input id="f1" aria-label="First name" /></label>
    <label>Last name <input id="f2" aria-label="Last name" /></label>
    <label>Email <input id="f3" aria-label="Email" /></label>
  </form>
  <pre id="state">step:0</pre>
  <script>
    let step = 0;
    function bumpStep() {
      step += 1;
      document.title = 'step:' + step;
      document.getElementById('state').textContent = 'step:' + step;
    }
    for (const id of ['f1', 'f2', 'f3']) {
      document.getElementById(id).addEventListener('input', bumpStep);
    }
  </script>
</body>
</html>`

export function multiStepFormNoSubmitHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-type', 'text/html')
  res.end(PAGE_HTML)
}
