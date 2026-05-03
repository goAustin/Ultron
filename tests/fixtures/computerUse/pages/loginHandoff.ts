/**
 * v3 Phase 6 fixture #4 — login handoff.
 *
 * Acceptance target: login pages with a `<input type="password">` are
 * exercised by `ComputerHandoffToUser`. Phase 6's automated test asserts:
 * (a) the password field appears in the DOM (so redaction has something
 * to detect); (b) `ComputerHandoffToUser` requires a non-headless session;
 * (c) the screenshot returned by an observation has `redacted: true` because
 * the password input matches the default sensitive-region selectors.
 *
 * The `/login` route sets a `session=abc` cookie when posted to (so a
 * `storageState` round-trip can be exercised in a follow-on test, mirroring
 * the Phase 4·3 acceptance pattern).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const FIXTURE_HOST = 'login.fixture.local'

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>login</title></head>
<body style="margin:0">
  <h1>Sign in</h1>
  <form aria-label="Sign in" action="/login" method="post">
    <label>Email <input id="email" aria-label="Email" type="text" /></label>
    <label>Password <input id="pw" aria-label="Password" type="password" /></label>
    <button id="signin" type="submit">Sign in</button>
  </form>
  <p>Use your work email to sign in.</p>
</body>
</html>`

export function loginHandoffHandler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'POST' && (req.url ?? '').startsWith('/login')) {
    res.setHeader('set-cookie', 'session=abc; Path=/')
    res.setHeader('content-type', 'text/html')
    res.end('<!DOCTYPE html><html><head><title>signed in</title></head><body>welcome</body></html>')
    return
  }
  // GET / and anything else → render the login page. The cookie-reflect
  // path lives only on POST so the fixture stays minimal.
  res.setHeader('content-type', 'text/html')
  res.end(PAGE_HTML)
}
