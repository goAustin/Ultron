/**
 * v3 Phase 6 fixture #3 — multi-step form WITH dangerous submit button.
 *
 * Acceptance target: dangerous actions are gated. The submit label
 * ("Submit Payment") matches `DANGEROUS_LABEL_RE` and the safety check
 * fires `riskLevel: 3` before the click is allowed.
 *
 * Form has a name field plus a "Submit Payment" button. Clicking the
 * button (without the safety check intercepting) would update title to
 * "submitted". The test uses the safety-check path to ensure the click
 * is gated, so the title should NOT change in the gated case.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const FIXTURE_HOST = 'multistepsubmit.fixture.local'

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>multi-step-submit</title></head>
<body style="margin:0">
  <h1>Checkout</h1>
  <form aria-label="Checkout form" onsubmit="return false">
    <label>Name <input id="name" aria-label="Cardholder name" /></label>
    <label>Card <input id="card" aria-label="Card number" /></label>
    <button id="submit" type="submit">Submit Payment</button>
  </form>
  <pre id="state">unsubmitted</pre>
  <script>
    document.getElementById('submit').addEventListener('click', () => {
      document.title = 'submitted';
      document.getElementById('state').textContent = 'submitted';
    });
  </script>
</body>
</html>`

export function multiStepFormSubmitHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-type', 'text/html')
  res.end(PAGE_HTML)
}
