/**
 * OpenInBrowserTool — launch an https URL in the user's default browser.
 *
 * The model uses Computer-Use to drive a headless Chromium *on behalf of*
 * the user. When the user wants to *consume* a page themselves (watch a
 * video, read an article, fill a form they want to control), headless
 * Chromium is the wrong primitive — it can't deliver media playback and
 * many sites resist automation. This tool hands off to the OS launcher
 * (`open` / `xdg-open` / `cmd start`) so the page opens in whatever
 * browser the user has already configured.
 *
 * Permission posture: returns `{ behavior: 'allow' }` so the cascade falls
 * through to per-host allow rules and the fallback ask, mirroring
 * `WebFetchTool`. The scheme allowlist (https / http only) lives in
 * `validateInput` so disallowed schemes never reach the launcher.
 */

import { spawn } from 'node:child_process'

import { buildTool } from '../core/tools/types.js'
import { extractHost } from '../web/domainPolicy.js'

const DESCRIPTION = [
  'Open an http(s) URL in the user\'s default browser via the OS launcher.',
  'Use this for "play / watch / show me / open this in my browser" requests',
  'where the user wants to consume the page themselves. Prefer over',
  'ComputerStart for media playback and any task the user (not the agent)',
  'will interact with — Computer-Use runs headless and cannot deliver',
  'video/audio playback to the user.',
].join(' ')

type Launcher = { command: string; prefixArgs: readonly string[] }

function platformLauncher(platform: NodeJS.Platform): Launcher | null {
  if (platform === 'darwin') return { command: 'open', prefixArgs: [] }
  if (platform === 'win32') return { command: 'cmd', prefixArgs: ['/c', 'start', ''] }
  // linux, freebsd, openbsd, etc.
  return { command: 'xdg-open', prefixArgs: [] }
}

export const OpenInBrowserTool = buildTool({
  name: 'OpenInBrowser',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Full http:// or https:// URL to open in the user\'s default browser',
      },
    },
    required: ['url'],
  },
  isMutating: false,
  isReadOnly: true,
  isConcurrencySafe: () => true,
  getDomain: (input) => {
    const url = typeof input.url === 'string' ? input.url : ''
    return extractHost(url) ?? undefined
  },

  async validateInput(input) {
    if (typeof input.url !== 'string' || input.url.trim() === '') {
      return { valid: false, message: 'url must be a non-empty string' }
    }
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      return { valid: false, message: 'url is not a valid URL' }
    }
    // Scheme allowlist — keep `file:`, `javascript:`, `data:`, `about:`,
    // `chrome:`, `vbscript:`, etc. far away from the OS launcher.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return {
        valid: false,
        message: `url must be http(s) (got ${parsed.protocol.replace(':', '')})`,
      }
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return { valid: false, message: 'URLs with userinfo are not supported' }
    }
    return { valid: true }
  },

  async checkPermissions() {
    return { behavior: 'allow' }
  },

  async call(input, _context, signal) {
    if (signal.aborted) {
      return { content: '[aborted]', isError: true, errorKind: 'aborted' }
    }
    const url = input.url as string
    const launcher = platformLauncher(process.platform)
    if (launcher === null) {
      return {
        content: `Unsupported platform: ${process.platform}`,
        isError: true,
        errorKind: 'execution_error',
      }
    }

    // URL passes as a separate argv element — never string-concatenated.
    // Detached + unref so the launcher (and the browser it spawns) outlives
    // this Node process. stdio ignored so the child cannot pipe back into us.
    try {
      const child = spawn(launcher.command, [...launcher.prefixArgs, url], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      // The launcher exits almost immediately after dispatching to the
      // browser; we don't wait for it. Any spawn-time error fires on the
      // 'error' event, which we surface synchronously below.
      const spawnError = await new Promise<Error | null>((resolve) => {
        child.once('error', (err) => resolve(err))
        // If the process is alive after one tick, treat spawn as successful.
        setImmediate(() => resolve(null))
      })
      if (spawnError !== null) {
        return {
          content: `Failed to launch browser: ${spawnError.message}`,
          isError: true,
          errorKind: 'execution_error',
        }
      }
      return {
        content: `Opened ${url} in default browser.`,
        isError: false,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: `Failed to launch browser: ${msg}`,
        isError: true,
        errorKind: 'execution_error',
      }
    }
  },
})
