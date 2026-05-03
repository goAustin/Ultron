/**
 * v3 Phase 6 — shared fixture-server harness for the Computer-Use acceptance
 * suite. Lifts the inline `createServer` pattern from
 * `playwrightBrowserSession.integration.test.ts:116-149` so every fixture
 * can mount itself with one call.
 *
 * Usage:
 *
 *   const { hostResolverRules, recordedRequests, close } =
 *     await startComputerUseFixtureServers({
 *       'searchform.fixture.local': searchFormHandler,
 *       'denied.local': makeDeniedHandler(),
 *     })
 *   try {
 *     // ... run test ...
 *   } finally {
 *     await close()
 *   }
 *
 * Each hostname binds to `127.0.0.1:0` (random ephemeral port). The returned
 * `hostResolverRules` is a comma-joined `MAP <host>:80 127.0.0.1:<port>`
 * string ready to pass to Chromium via `--host-resolver-rules`.
 *
 * `recordedRequests` is keyed by hostname and accumulates one entry per
 * incoming request (host header + URL path) so tests can assert "the denied
 * server saw 0 requests" without each fixture re-implementing a request log.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'

export type FixtureRoutes = Record<
  string,
  (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
>

export type RecordedRequest = {
  /** Host header as the client sent it. May or may not include `:port`. */
  readonly host: string
  /** Request URL (path + query, never the absolute form). */
  readonly url: string
}

export type ComputerUseFixtureServers = {
  readonly hostResolverRules: string
  readonly recordedRequests: Record<string, RecordedRequest[]>
  readonly close: () => Promise<void>
}

export async function startComputerUseFixtureServers(
  routes: FixtureRoutes,
): Promise<ComputerUseFixtureServers> {
  const hosts = Object.keys(routes)
  if (hosts.length === 0) {
    throw new Error('startComputerUseFixtureServers requires at least one host route')
  }

  const recordedRequests: Record<string, RecordedRequest[]> = {}
  for (const host of hosts) recordedRequests[host] = []

  const servers: Server[] = []
  const mappings: string[] = []

  // Tear down any servers already started before re-throwing the original
  // listen error. Without this, an EPERM/EADDRINUSE on host #2 of 3 would
  // leak the port from host #1 until process exit.
  const teardownStartedServers = async (): Promise<void> => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  }

  // Bind one server per host. Sequential rather than parallel so any failure
  // surfaces a clean partial-state for cleanup.
  for (const host of hosts) {
    const handler = routes[host]
    if (handler === undefined) continue
    const server = createServer((req, res) => {
      const headerHost = req.headers.host ?? '<unknown>'
      recordedRequests[host]!.push({ host: headerHost, url: req.url ?? '' })
      try {
        const maybe = handler(req, res)
        if (maybe instanceof Promise) {
          maybe.catch((err) => {
            // Don't crash the server on a buggy fixture handler — the test
            // will surface the failure through assertions.
            res.statusCode = 500
            res.end(`fixture handler error: ${err instanceof Error ? err.message : String(err)}`)
          })
        }
      } catch (err) {
        res.statusCode = 500
        res.end(`fixture handler error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    // Subscribe to BOTH 'listening' (resolve) AND 'error' (reject). Without
    // the error listener, an EPERM/EADDRINUSE on `listen()` would never
    // resolve the promise — every awaiting test would hang to its timeout.
    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        const onError = (err: Error): void => {
          server.off('listening', onListening)
          reject(err)
        }
        server.once('listening', onListening)
        server.once('error', onError)
        server.listen(0, '127.0.0.1')
      })
    } catch (err) {
      await teardownStartedServers()
      throw new Error(
        `fixture server failed to listen for host "${host}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const port = (server.address() as AddressInfo).port
    servers.push(server)
    mappings.push(`MAP ${host}:80 127.0.0.1:${port}`)
  }

  // Idempotent so a test that calls `close()` to simulate a mid-response
  // server kill can still rely on the standard `cleanup()` afterwards
  // without tripping a "Server is not running" error.
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const server of servers) {
      // `server.close()` only stops accepting new connections; existing
      // sockets that are mid-response (e.g. fixtures with an artificial
      // delay) keep the close pending until they finish or time out. For
      // failure-recovery tests that want to simulate "server died mid-
      // request", `closeAllConnections()` (Node ≥ 18.2) destroys those
      // sockets immediately so the client side sees an RST.
      const maybeKillAll = (server as unknown as { closeAllConnections?: () => void })
        .closeAllConnections
      if (typeof maybeKillAll === 'function') maybeKillAll.call(server)
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    }
  }

  return {
    hostResolverRules: mappings.join(', '),
    recordedRequests,
    close,
  }
}

/**
 * Convenience handler for hostnames that should never be reached. Records
 * every request via the harness's `recordedRequests` map; the response body
 * is a 500 with a sentinel string so a misrouted request is visible.
 */
export function makeDeniedHandler(): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain')
    res.end('SHOULD NOT BE REACHED — denied host')
  }
}
