/**
 * v3 Phase 6 fixture #10 — download/upload behavior under default settings.
 *
 * Acceptance target: behavioral snapshot of CURRENT runtime (NOT a "blocked
 * by policy" assertion). The session enforces `acceptDownloads: false`
 * (`playwrightBrowserSession.ts:89`); a `<a download>` click therefore
 * cannot result in a saved file. The fixture also renders an
 * `<input type="file">` so the test can confirm that without a programmatic
 * `setInputFiles()` no file picker is driven by Computer-Use tools.
 *
 * Note: `allowDownloads` / `allowUploads` settings exist (`computerUseSettings.ts`)
 * but are NOT enforced by the runtime. Real policy enforcement is out of v3
 * scope; this fixture documents what Phase 2's session config provides today.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export const FIXTURE_HOST = 'download.fixture.local'

const FILE_CONTENT = 'this should never be saved by Computer-Use'

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>downloads</title></head>
<body style="margin:0">
  <h1>Downloads</h1>
  <p><a id="dl" href="/file.txt" download="file.txt">Download file</a></p>
  <p><label>Upload <input id="upload" aria-label="Upload file" type="file" /></label></p>
  <pre id="state">none</pre>
  <script>
    document.getElementById('upload').addEventListener('change', () => {
      const f = document.getElementById('upload').files;
      document.title = 'uploaded:' + (f && f.length || 0);
      document.getElementById('state').textContent = 'uploaded:' + (f && f.length || 0);
    });
  </script>
</body>
</html>`

export function downloadUploadHandler(req: IncomingMessage, res: ServerResponse): void {
  if ((req.url ?? '').startsWith('/file.txt')) {
    res.setHeader('content-type', 'text/plain')
    res.setHeader('content-disposition', 'attachment; filename="file.txt"')
    res.end(FILE_CONTENT)
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end(PAGE_HTML)
}
