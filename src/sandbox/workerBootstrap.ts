/**
 * Worker bootstrap source — exported as a string and passed to
 * `new Worker(BOOTSTRAP_SOURCE, { eval: true })` from `runtime.ts`.
 *
 * Why a string instead of a separate `worker.js` file: avoids `import.meta.url`
 * resolution drift between vitest (running `.ts` from `src/`) and the built
 * artifact (`.js` in `dist/`). The bootstrap is small and self-contained.
 *
 * The worker runs as CommonJS — `require()` is available, ESM `import` is not.
 * Branches on the request `language`. Console formatting is implemented as a
 * JS shim injected INSIDE QuickJS (so `typeof` works on native QuickJS
 * values); the shim calls a single host bridge `__sandboxPostLine(channel, line)`.
 *
 * Output capping: ONE shared byte budget across stdout+stderr (so the
 * 64 KB cap is a total ceiling, not per-stream). UTF-8-safe slicing —
 * partial multibyte sequences are dropped rather than decoded as U+FFFD.
 *
 * Python isolation: `jsglobals: {}` passed to loadPyodide so `from js import
 * process` etc. fails — Python cannot reach Node host globals.
 *
 * Python memory cap (best-effort): a setInterval polls
 * `pyodide._module.HEAPU8.byteLength` and posts a kill marker on overrun.
 * KNOWN LIMIT: Pyodide's `runPythonAsync` runs through Promise microtasks
 * (e.g., `asyncio.sleep(0)` → microtask), starving the macrotask queue
 * — so the poll is silent during tight Python loops. It catches sustained
 * leaks that pass through real macrotask boundaries (`js.fetch`, etc.) but
 * NOT a single big allocation in one Python opcode. The hard caps are
 * (a) wall-clock + `worker.terminate()` from the parent (rock-solid) and
 * (b) Pyodide's compiled-in WASM max-memory (~4 GB). True per-call
 * memory enforcement requires `child_process.fork` + OS `setrlimit` and
 * is deferred to a future hardening phase.
 */

const MAX_PY_MEMORY_BYTES = 256 * 1024 * 1024
const PY_MEMORY_POLL_INTERVAL_MS = 100

export const BOOTSTRAP_SOURCE = String.raw`
const { parentPort } = require('worker_threads')

if (!parentPort) process.exit(1)

const MAX_PY_MEMORY_BYTES = ${MAX_PY_MEMORY_BYTES}
const PY_MEMORY_POLL_INTERVAL_MS = ${PY_MEMORY_POLL_INTERVAL_MS}

// ---- Output cap (shared budget, UTF-8 safe) -------------------------------

function createByteBudget(maxBytes) {
  return { remaining: maxBytes, truncated: false }
}

function utf8SafeBoundary(buf, max) {
  if (max <= 0) return 0
  if (max >= buf.length) return buf.length
  if ((buf[max] & 0xc0) !== 0x80) return max
  let i = max - 1
  while (i > 0 && (buf[i] & 0xc0) === 0x80) i--
  return i
}

function createCappedAppender(budget) {
  const chunks = []
  return {
    append(s) {
      if (!s || s.length === 0) return
      if (budget.remaining <= 0) { budget.truncated = true; return }
      const buf = Buffer.from(String(s), 'utf8')
      if (buf.length <= budget.remaining) {
        chunks.push(buf)
        budget.remaining -= buf.length
      } else {
        const cut = utf8SafeBoundary(buf, budget.remaining)
        if (cut > 0) chunks.push(buf.subarray(0, cut))
        budget.remaining = 0
        budget.truncated = true
      }
    },
    value() { return Buffer.concat(chunks).toString('utf8') },
  }
}

// Console shim injected INSIDE QuickJS (so typeof works on native values).
const CONSOLE_SHIM = ${'`'}
  globalThis.console = (function (post) {
    const fmt = (args) => args.map((a) => {
      if (typeof a === 'string') return a
      if (a === undefined) return 'undefined'
      try { return JSON.stringify(a) } catch (_) { return String(a) }
    }).join(' ')
    const out = (...args) => post('stdout', fmt(args) + '\\n')
    const err = (...args) => post('stderr', fmt(args) + '\\n')
    return { log: out, info: out, debug: out, warn: err, error: err }
  })(globalThis.__sandboxPostLine)
  // Hide the bridge from user code after capture.
  delete globalThis.__sandboxPostLine
${'`'}

// ---- JS branch (QuickJS) --------------------------------------------------

async function runJs(req) {
  const { getQuickJS } = require('quickjs-emscripten')
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(64 * 1024 * 1024)
  const ctx = runtime.newContext()

  const budget = createByteBudget(req.maxOutputBytes)
  const stdoutCap = createCappedAppender(budget)
  const stderrCap = createCappedAppender(budget)
  let exitError

  try {
    const postLine = ctx.newFunction('__sandboxPostLine', (channelH, lineH) => {
      const channel = ctx.getString(channelH)
      const line = ctx.getString(lineH)
      if (channel === 'stderr') stderrCap.append(line)
      else stdoutCap.append(line)
      return ctx.undefined
    })
    ctx.setProp(ctx.global, '__sandboxPostLine', postLine)
    postLine.dispose()

    const shimResult = ctx.evalCode(CONSOLE_SHIM)
    if (shimResult.error) {
      exitError = 'console shim failed: ' + JSON.stringify(ctx.dump(shimResult.error))
      shimResult.error.dispose()
    } else {
      shimResult.value.dispose()
      const result = ctx.evalCode(req.code)
      if (result.error) {
        const errDump = ctx.dump(result.error)
        exitError = (errDump && typeof errDump === 'object' && errDump.message)
          ? String(errDump.message)
          : (typeof errDump === 'string' ? errDump : JSON.stringify(errDump))
        result.error.dispose()
      } else {
        // REPL-style: print the final expression value if not undefined.
        const t = ctx.typeof(result.value)
        if (t !== 'undefined') {
          const v = ctx.dump(result.value)
          if (v !== undefined) {
            const formatted = (typeof v === 'string')
              ? v
              : (() => { try { return JSON.stringify(v) } catch (_) { return String(v) } })()
            stdoutCap.append(formatted + '\n')
          }
        }
        result.value.dispose()
      }
    }
  } finally {
    try { ctx.dispose() } catch (_) {}
    try { runtime.dispose() } catch (_) {}
  }

  parentPort.postMessage({
    stdout: stdoutCap.value(),
    stderr: stderrCap.value(),
    truncated: budget.truncated,
    ...(exitError !== undefined && { exitError }),
  })
}

// ---- Python branch (Pyodide) ---------------------------------------------

async function runPython(req) {
  let pyodideMod
  try {
    pyodideMod = require('pyodide')
  } catch (_) {
    parentPort.postMessage({
      stdout: '',
      stderr: '',
      truncated: false,
      exitError: 'Python sandbox unavailable: install peer dep "pyodide" (npm install pyodide)',
    })
    return
  }

  const budget = createByteBudget(req.maxOutputBytes)
  const stdoutCap = createCappedAppender(budget)
  const stderrCap = createCappedAppender(budget)
  let exitError
  let memoryPollHandle
  let pyodide
  let memoryKilled = false

  try {
    pyodide = await pyodideMod.loadPyodide({
      // Lock down JS globals so 'from js import process' / fetch / etc. fail.
      // Default would be globalThis — which in a Node worker exposes process,
      // Buffer, require, and other host bindings.
      jsglobals: {},
      stdout: (line) => stdoutCap.append(line + '\n'),
      stderr: (line) => stderrCap.append(line + '\n'),
    })

    // Memory polling: WASM linear memory is independent of V8 resourceLimits.
    // If runaway code grows pyodide._module.HEAPU8 past 256 MB, post the
    // kill marker and hard-exit the worker so the host doesn't OOM.
    memoryPollHandle = setInterval(() => {
      try {
        const used = pyodide._module && pyodide._module.HEAPU8
          ? pyodide._module.HEAPU8.byteLength
          : 0
        if (used > MAX_PY_MEMORY_BYTES) {
          memoryKilled = true
          clearInterval(memoryPollHandle)
          parentPort.postMessage({
            stdout: stdoutCap.value(),
            stderr: stderrCap.value(),
            truncated: budget.truncated,
            exitError: '[killed: WASM memory exceeded ' + Math.floor(MAX_PY_MEMORY_BYTES / (1024 * 1024)) + ' MB]',
          })
          process.exit(0)
        }
      } catch (_) { /* ignore */ }
    }, PY_MEMORY_POLL_INTERVAL_MS)

    try {
      await pyodide.runPythonAsync(req.code)
    } catch (e) {
      exitError = (e && e.message) ? String(e.message) : String(e)
    }
  } catch (e) {
    if (!memoryKilled) {
      exitError = 'pyodide init failed: ' + ((e && e.message) ? String(e.message) : String(e))
    }
  } finally {
    if (memoryPollHandle) clearInterval(memoryPollHandle)
  }

  if (memoryKilled) return // already posted

  parentPort.postMessage({
    stdout: stdoutCap.value(),
    stderr: stderrCap.value(),
    truncated: budget.truncated,
    ...(exitError !== undefined && { exitError }),
  })
}

// ---- Dispatcher ----------------------------------------------------------

parentPort.once('message', async (req) => {
  try {
    if (req && req.language === 'javascript') return await runJs(req)
    if (req && req.language === 'python') return await runPython(req)
    parentPort.postMessage({
      stdout: '',
      stderr: '',
      truncated: false,
      exitError: 'unknown language: ' + (req && req.language),
    })
  } catch (e) {
    parentPort.postMessage({
      stdout: '',
      stderr: '',
      truncated: false,
      exitError: (e && e.message) ? String(e.message) : String(e),
    })
  }
  // Don't process.exit on the success path — parent calls worker.terminate().
})
`
