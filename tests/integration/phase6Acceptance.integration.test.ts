/**
 * v3 Phase 6 — end-to-end acceptance integration suite.
 *
 * Gated by `ULTRON_PLAYWRIGHT_INTEGRATION=1` (mirrors `seatbelt.integration.test.ts`'s
 * `isDarwin` gate and the existing Phase 2 Playwright integration suite).
 * When the env var is unset, the suite is skipped, so a fresh checkout that
 * hasn't run `npx playwright install chromium` keeps `npm run test` green.
 *
 * Run:
 *   ULTRON_PLAYWRIGHT_INTEGRATION=1 npx vitest run \
 *     tests/integration/phase6Acceptance.integration.test.ts
 *
 * Each `it()` drives one v3-roadmap acceptance scenario through the
 * `createComputerUseTools(...)` factory — same surface a real model uses —
 * and asserts both behavior + the post-session metrics envelope returned
 * by `getSessionMetrics(sessionId)`.
 *
 * See `docs/ultron_v3/v3-phase6-design.md`.
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from '../../src/config/computerUseSettings.js'
import { makeComputerUseSafetyCheck } from '../../src/core/permissions/computerSafetyChecks.js'
import { createComputerUseTools, type ComputerUseTools } from '../../src/tools/ComputerTools.js'
import { createToolRegistry } from '../../src/core/tools/registry.js'
import { createStore, getDefaultAppState } from '../../src/core/state.js'
import { authorizeToolUse, runToolUse } from '../../src/core/tools/runToolUse.js'
import { toolUseId, type ToolUseBlock } from '../../src/core/messages.js'

import {
  startComputerUseFixtureServers,
  makeDeniedHandler,
  type ComputerUseFixtureServers,
  type FixtureRoutes,
} from '../fixtures/computerUse/server.js'
import {
  FIXTURE_HOST as SEARCHFORM_HOST,
  searchFormHandler,
} from '../fixtures/computerUse/pages/searchForm.js'
import {
  FIXTURE_HOST as MULTISTEP_HOST,
  multiStepFormNoSubmitHandler,
} from '../fixtures/computerUse/pages/multiStepFormNoSubmit.js'
import {
  FIXTURE_HOST as MULTISTEPSUBMIT_HOST,
  multiStepFormSubmitHandler,
} from '../fixtures/computerUse/pages/multiStepFormSubmit.js'
import {
  FIXTURE_HOST as LOGIN_HOST,
  loginHandoffHandler,
} from '../fixtures/computerUse/pages/loginHandoff.js'
import {
  FIXTURE_HOST as DANGEROUS_HOST,
  dangerousButtonsHandler,
} from '../fixtures/computerUse/pages/dangerousButtons.js'
import {
  FIXTURE_HOST as MODAL_HOST,
  modalPopupHandler,
} from '../fixtures/computerUse/pages/modalPopup.js'
import {
  FIXTURE_HOST as SCROLL_HOST,
  infiniteScrollHandler,
} from '../fixtures/computerUse/pages/infiniteScroll.js'
import {
  FIXTURE_HOST as INJECT_HOST,
  promptInjectionHandler,
} from '../fixtures/computerUse/pages/promptInjection.js'
import {
  FIXTURE_HOST as SLOW_HOST,
  makeSlowLoadHandler,
  makeStabilizeHungHandler,
} from '../fixtures/computerUse/pages/slowLoad.js'
import {
  FIXTURE_HOST as DOWNLOAD_HOST,
  downloadUploadHandler,
} from '../fixtures/computerUse/pages/downloadUpload.js'

import { buildAtomCache } from '../../src/core/computer/selectorCache.js'
import { createPlaywrightSessionFactory } from '../../src/core/computer/playwrightBrowserSession.js'
import {
  SessionManager,
  type BrowserSessionFactory,
} from '../../src/core/computer/sessionManager.js'
import { __setStoragePathForTest } from '../../src/core/computer/storageStateStore.js'
import {
  type ComputerSessionId,
  type StartSessionOptions,
} from '../../src/core/computer/types.js'

const integrationEnabled = process.env.ULTRON_PLAYWRIGHT_INTEGRATION === '1'

const SLOW_LOAD_DELAY_MS = Number(process.env.ULTRON_SLOW_LOAD_DELAY_MS ?? '3000')

// Inline-inferred context shape so `readFileState: new Map()` matches
// `ReadFileState` (Map<string, ReadFileEntry>) without an explicit type
// annotation forcing `Map<unknown, unknown>`.
function makeContext() {
  return {
    appState: createStore(getDefaultAppState()),
    abortController: new AbortController(),
    messages: [],
    readFileState: new Map<string, never>(),
    toolRegistry: createToolRegistry(),
  }
}

type FixtureCtx = ReturnType<typeof makeContext>

function makeSettings(partial: Partial<ComputerUseSettings> = {}): ComputerUseSettings {
  return {
    ...defaultComputerUseSettings,
    viewport: { ...defaultComputerUseSettings.viewport },
    displaySize: { ...defaultComputerUseSettings.displaySize },
    maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
    enabled: true,
    deniedDomains: [],
    maxDurationMs: 60_000,
    ...partial,
  }
}

type FixtureRig = {
  servers: ComputerUseFixtureServers
  mgr: SessionManager
  tools: ComputerUseTools
  ctx: FixtureCtx
  storageDir: string
  cleanup: () => Promise<void>
}

function findPngFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      out.push(...findPngFiles(path))
      continue
    }
    if (name.toLowerCase().endsWith('.png')) out.push(path)
  }
  return out
}

function assertNoDebugPngs(storageDir: string): void {
  const pngs = findPngFiles(storageDir)
  expect(
    pngs,
    `debugPersistScreenshots=false should not write PNGs under ${storageDir}`,
  ).toEqual([])
}

async function setupFixture(opts: {
  routes: FixtureRoutes
  settingsPartial?: Partial<ComputerUseSettings>
  /**
   * Per-session DSF override; threaded through the wrapped factory. Required
   * for the DSF=2 acceptance test only.
   */
  deviceScaleFactor?: number
}): Promise<FixtureRig> {
  const servers = await startComputerUseFixtureServers(opts.routes)
  const settings = makeSettings(opts.settingsPartial)
  const storageDir = mkdtempSync(join(tmpdir(), 'ultron-phase6-storage-'))
  __setStoragePathForTest(storageDir)
  const baseFactory = createPlaywrightSessionFactory()
  // Wrap factory: tools.start.call doesn't expose hostResolverRules /
  // allowHttpForTest / deviceScaleFactor (those are policy/test concerns,
  // not model-facing inputs), so we inject them at the factory layer.
  const wrappedFactory: BrowserSessionFactory = async (params) => {
    const enrichedOpts: StartSessionOptions = {
      ...params.options,
      requireAllowlist: true,
      allowHttpForTest: true,
      hostResolverRules: servers.hostResolverRules,
      ...(opts.deviceScaleFactor !== undefined
        ? { deviceScaleFactor: opts.deviceScaleFactor }
        : {}),
    }
    return baseFactory({ ...params, options: enrichedOpts })
  }
  const mgr = new SessionManager({ settings, factory: wrappedFactory })
  const tools = createComputerUseTools({ sessionManager: mgr, settings })
  const ctx = makeContext()
  for (const tool of Object.values(tools)) {
    ctx.toolRegistry.register(tool)
  }
  return {
    servers,
    mgr,
    tools,
    ctx,
    storageDir,
    cleanup: async () => {
      let primaryError: unknown = null
      try {
        await mgr.stopAll()
        assertNoDebugPngs(storageDir)
      } catch (err) {
        primaryError = err
      }
      try {
        await servers.close()
      } finally {
        __setStoragePathForTest(null)
        rmSync(storageDir, { recursive: true, force: true })
      }
      if (primaryError !== null) throw primaryError
    },
  }
}

/**
 * Drive `tools.start.call(...)` and return the parsed sessionId. Asserts
 * non-error so caller can proceed without re-checking.
 */
async function startSession(
  rig: FixtureRig,
  input: { headless?: boolean; initialUrl?: string } = {},
): Promise<ComputerSessionId> {
  const result = await rig.tools.start.call(input, rig.ctx, rig.ctx.abortController.signal)
  expect(result.isError, `start failed: ${result.content}`).toBe(false)
  const id = result.content.replace('sessionId: ', '') as ComputerSessionId
  expect(rig.mgr.get(id)).toBeDefined()
  return id
}

function computerToolUse(
  name: string,
  input: Record<string, unknown>,
  suffix: string,
): ToolUseBlock {
  return {
    type: 'tool_use',
    id: toolUseId(`phase6-${suffix}`),
    name,
    input,
  }
}

async function expectActAtomGatedByPermissionCascade(opts: {
  rig: FixtureRig
  sessionId: ComputerSessionId
  atomId: string
  suffix: string
  expectedRiskCategory?: string
}): Promise<void> {
  const input = {
    sessionId: opts.sessionId,
    atomId: opts.atomId,
    action: { type: 'click', button: 'left' },
  }
  const toolUse = computerToolUse('ComputerActAtom', input, opts.suffix)
  const permissionOpts = {
    headless: false,
    safetyChecks: [makeComputerUseSafetyCheck({ sessionManager: opts.rig.mgr })],
  }

  const beforeSteps = opts.rig.mgr.getSessionMetrics(opts.sessionId)?.stepCount ?? 0
  const auth = await authorizeToolUse(
    toolUse,
    opts.rig.ctx,
    opts.rig.ctx.abortController.signal,
    permissionOpts,
  )
  expect(auth.outcome).toBe('denied')
  if (auth.outcome !== 'denied') throw new Error('expected denied authorization')
  expect(auth.decision.decision).toBe('ask')
  expect(auth.syntheticResult.errorKind).toBe('permission_ask')
  expect(auth.decision.safetyMetadata?.riskLevel).toBe(3)
  if (opts.expectedRiskCategory !== undefined) {
    expect(auth.decision.safetyMetadata?.riskCategory).toBe(opts.expectedRiskCategory)
  }

  const result = await runToolUse(
    toolUse,
    opts.rig.ctx,
    opts.rig.ctx.abortController.signal,
    permissionOpts,
  )
  expect(result.isError).toBe(true)
  expect(result.errorKind).toBe('permission_ask')
  expect(opts.rig.mgr.getSessionMetrics(opts.sessionId)?.stepCount).toBe(beforeSteps)
}

describe.skipIf(!integrationEnabled)('Phase 6 — Acceptance integration', () => {
  // Each test owns its own rig (servers + manager + tools) so failures don't
  // leak Playwright contexts into the next case. `afterEach` would re-run
  // cleanup but per-test setup keeps the lifecycle explicit.
  let activeRig: FixtureRig | null = null

  beforeEach(() => {
    activeRig = null
  })

  afterAll(async () => {
    if (activeRig !== null) await activeRig.cleanup()
  })

  // -------------------------------------------------------------------------
  // Fixture #1 — search form (Browser MVP succeeds on simple local form tasks).
  // -------------------------------------------------------------------------

  it('fixture 1: search form — atom-path fill + click drives a result through ComputerObserve', async () => {
    const rig = await setupFixture({
      routes: { [SEARCHFORM_HOST]: searchFormHandler },
      settingsPartial: { allowedDomains: [SEARCHFORM_HOST] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      const session = rig.mgr.get(sessionId)!

      // Navigate via the tool surface so the metrics + safety + verify spine
      // all run for real.
      const navResult = await rig.tools.navigate.call(
        { sessionId, url: `http://${SEARCHFORM_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(navResult.isError, navResult.content).toBe(false)

      // ARIA-derived atom catalog. The page exposes a textbox ("Search query")
      // and a submit button ("Search"). We don't assert on serializeAtoms
      // shape (covered by atomResolver tests); we just need a working cache.
      const obsResult = await rig.tools.observeActions.call(
        { sessionId },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(obsResult.isError, obsResult.content).toBe(false)

      // The cache is now populated; pull entries directly via the locator
      // helper used internally by ComputerActAtom — same code path, simpler
      // to assert on.
      const ariaSnap = await session.ariaSnapshot(rig.ctx.abortController.signal)
      const cache = buildAtomCache(ariaSnap, session.currentUrl() ?? '')
      session.setAtomCache(cache)

      const inputEntry = [...cache.entries.entries()].find(
        ([, e]) => e.locatorName === 'Search query',
      )
      expect(inputEntry, `expected Search-query atom; got ${[...cache.entries.values()].map((e) => e.locatorName).join('|')}`).toBeDefined()
      const buttonEntry = [...cache.entries.entries()].find(
        ([, e]) => e.role === 'button' && e.locatorName === 'Search',
      )
      expect(buttonEntry, 'expected Search button atom').toBeDefined()

      // Fill via atom path.
      const fillResult = await rig.tools.actAtom.call(
        {
          sessionId,
          atomId: inputEntry![0],
          action: { type: 'fill', text: 'hello' },
        },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(fillResult.isError, fillResult.content).toBe(false)

      // Re-prime cache for the click — `runActionAndObserve` recaptures ARIA
      // after every mutation, so the post-fill atomCache is already current
      // for the *previous* observation; we need a fresh one to keep `nth`
      // valid against the live DOM. Cheaper than re-running ObserveActions.
      const ariaSnap2 = await session.ariaSnapshot(rig.ctx.abortController.signal)
      const cache2 = buildAtomCache(ariaSnap2, session.currentUrl() ?? '')
      session.setAtomCache(cache2)
      const buttonEntry2 = [...cache2.entries.entries()].find(
        ([, e]) => e.role === 'button' && e.locatorName === 'Search',
      )
      expect(buttonEntry2).toBeDefined()

      const clickResult = await rig.tools.actAtom.call(
        {
          sessionId,
          atomId: buttonEntry2![0],
          action: { type: 'click', button: 'left' },
        },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(clickResult.isError, clickResult.content).toBe(false)

      // Final observation should reflect the title change.
      const final = await session.currentTitle()
      expect(final).toBe('results: hello')

      // v3 Phase 6 metrics surface: at least 1 step counted (click), at least
      // 1 screenshot taken (auto-observe after each mutating action), and
      // the session is still live (no closeReason yet).
      const metrics = rig.mgr.getSessionMetrics(sessionId)
      expect(metrics).not.toBeNull()
      expect(metrics!.stepCount).toBeGreaterThanOrEqual(2) // navigate + click
      expect(metrics!.screenshotCount).toBeGreaterThan(0)
      expect(metrics!.screenshotBytesTotal).toBeGreaterThan(0)
      expect(metrics!.closeReason).toBeNull()

      // Debug-screenshots-off proof runs in fixture cleanup.
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  })

  // -------------------------------------------------------------------------
  // Fixture #2 — multi-step form (no submit). DOM-first happy path; the
  // selector cache hits on replay; verifyActions=true never trips a false stall.
  // -------------------------------------------------------------------------

  it('fixture 2: multi-step form — atom-path fills 3 inputs, no false-positive stall', async () => {
    const rig = await setupFixture({
      routes: { [MULTISTEP_HOST]: multiStepFormNoSubmitHandler },
      settingsPartial: {
        allowedDomains: [MULTISTEP_HOST],
        verifyActions: true,
      },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      const session = rig.mgr.get(sessionId)!

      const navResult = await rig.tools.navigate.call(
        { sessionId, url: `http://${MULTISTEP_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(navResult.isError, navResult.content).toBe(false)

      // Three sequential fills via the atom path.
      const labels = ['First name', 'Last name', 'Email']
      const texts = ['Ada', 'Lovelace', 'ada@example.invalid']
      for (let i = 0; i < labels.length; i++) {
        const aria = await session.ariaSnapshot(rig.ctx.abortController.signal)
        const cache = buildAtomCache(aria, session.currentUrl() ?? '')
        session.setAtomCache(cache)
        const entry = [...cache.entries.entries()].find(
          ([, e]) => e.locatorName === labels[i],
        )
        expect(entry, `expected ${labels[i]} atom`).toBeDefined()
        const r = await rig.tools.actAtom.call(
          {
            sessionId,
            atomId: entry![0],
            action: { type: 'fill', text: texts[i] },
          },
          rig.ctx,
          rig.ctx.abortController.signal,
        )
        expect(r.isError, r.content).toBe(false)
      }

      // The page increments document.title by one per `input` event.
      const finalTitle = await session.currentTitle()
      // Each `fill` synthesizes one input event per character; we don't pin
      // the exact count (it depends on Playwright's fill implementation), but
      // the title must match the "step:<N>" pattern with N≥3.
      expect(finalTitle).toMatch(/^step:\d+$/)
      const stepNum = Number(finalTitle!.replace('step:', ''))
      expect(stepNum).toBeGreaterThanOrEqual(3)

      const metrics = rig.mgr.getSessionMetrics(sessionId)
      expect(metrics).not.toBeNull()
      // 1 navigate + 3 fills = 4 mutating actions.
      expect(metrics!.stepCount).toBeGreaterThanOrEqual(4)
      expect(metrics!.closeReason).toBeNull()
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  })

  // -------------------------------------------------------------------------
  // Fixture #3 — multi-step form WITH dangerous submit button. End-to-end
  // gate proof: drive the actual `makeComputerUseSafetyCheck` (the SafetyCheck
  // the production permission cascade runs at step 4) against a primed live
  // session. ARIA + atom cache come from a real `ComputerObserveActions` call
  // — not a hand-built classifier input — so a regression that broke ARIA
  // capture, atom cache priming, or the safety-check seam itself would trip.
  // -------------------------------------------------------------------------

  it('fixture 3: multi-step form submit — safety check returns ask + level 3 for the Submit Payment atom', async () => {
    const rig = await setupFixture({
      routes: { [MULTISTEPSUBMIT_HOST]: multiStepFormSubmitHandler },
      settingsPartial: { allowedDomains: [MULTISTEPSUBMIT_HOST] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      const session = rig.mgr.get(sessionId)!

      await rig.tools.navigate.call(
        { sessionId, url: `http://${MULTISTEPSUBMIT_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )

      // Prime ARIA + atom cache via the production tool surface. After this
      // the safety check can pull `lastAriaSnapshot()` + `lookupAtom(...)`
      // synchronously, just as the cascade does.
      const obs = await rig.tools.observeActions.call(
        { sessionId },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(obs.isError, obs.content).toBe(false)

      const cache = session.currentAtomCache()
      expect(cache, 'expected primed atom cache after observeActions').not.toBeNull()
      const submit = [...cache!.entries.values()].find(
        (e) => e.role === 'button' && e.locatorName === 'Submit Payment',
      )
      expect(submit, 'expected Submit Payment atom').toBeDefined()

      await expectActAtomGatedByPermissionCascade({
        rig,
        sessionId,
        atomId: submit!.atomId,
        suffix: 'submit-payment',
        expectedRiskCategory: 'irreversible',
      })

      const metrics = rig.mgr.getSessionMetrics(sessionId)
      expect(metrics!.stepCount).toBeGreaterThanOrEqual(1) // navigate
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  })

  // -------------------------------------------------------------------------
  // Fixture #4 — login handoff page. Phase 4·2 redaction kicks in for
  // password fields; a screenshot of this page must come back with
  // attachment.redacted === true.
  // -------------------------------------------------------------------------

  it('fixture 4: login page — screenshot is redacted because the password field is detected', async () => {
    const rig = await setupFixture({
      routes: { [LOGIN_HOST]: loginHandoffHandler },
      settingsPartial: { allowedDomains: [LOGIN_HOST] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig, { headless: true })
      const session = rig.mgr.get(sessionId)!

      await rig.tools.navigate.call(
        { sessionId, url: `http://${LOGIN_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )

      const shot = await session.screenshot(rig.ctx.abortController.signal)
      expect(shot.attachment.redacted).toBe(true)
      // The fixture's title is "login" — assert the observation reflects it
      // so we know we actually rendered the right page.
      expect(shot.observation.title).toBe('login')

      const metrics = rig.mgr.getSessionMetrics(sessionId)
      // navigate's auto-observe + this explicit screenshot = ≥2 captures.
      // Don't pin the exact count or byte total since auto-observe varies
      // across the action stack; just assert the totals are non-zero and
      // include at least the byteSize we just observed.
      expect(metrics!.screenshotCount).toBeGreaterThanOrEqual(2)
      expect(metrics!.screenshotBytesTotal).toBeGreaterThanOrEqual(shot.attachment.byteSize)
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  })

  // -------------------------------------------------------------------------
  // Fixture #5 — every dangerous label classifies at level 3; the decoy
  // "Search" button classifies at level ≤ 1.
  // -------------------------------------------------------------------------

  it('fixture 5: dangerous-button matrix — safety check gates Pay/Delete/Send/Confirm/Publish; Search defers', async () => {
    const rig = await setupFixture({
      routes: { [DANGEROUS_HOST]: dangerousButtonsHandler },
      settingsPartial: { allowedDomains: [DANGEROUS_HOST] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      const session = rig.mgr.get(sessionId)!
      await rig.tools.navigate.call(
        { sessionId, url: `http://${DANGEROUS_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )

      const obs = await rig.tools.observeActions.call(
        { sessionId },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(obs.isError, obs.content).toBe(false)
      const cache = session.currentAtomCache()
      expect(cache, 'expected primed atom cache after observeActions').not.toBeNull()

      // Each dangerous label drives the production authorization path:
      // registry resolve -> validateInput -> permission cascade -> safety check
      // -> synthetic permission_ask. `runToolUse` then proves execution is
      // short-circuited by checking the step counter does not advance.
      for (const label of ['Pay', 'Delete', 'Send', 'Confirm', 'Publish']) {
        const atom = [...cache!.entries.values()].find(
          (e) => e.role === 'button' && e.locatorName === label,
        )
        expect(atom, `missing atom for "${label}"`).toBeDefined()
        await expectActAtomGatedByPermissionCascade({
          rig,
          sessionId,
          atomId: atom!.atomId,
          suffix: `dangerous-${label.toLowerCase()}`,
        })
      }

      // Decoy: a non-dangerous label must NOT gate. `decisionFromAssessment`
      // returns `null` for level ≤ 1, so the cascade reaches fallback ask
      // without structured safety metadata.
      const search = [...cache!.entries.values()].find(
        (e) => e.role === 'button' && e.locatorName === 'Search',
      )
      expect(search).toBeDefined()
      const decoyInput = {
        sessionId,
        atomId: search!.atomId,
        action: { type: 'click', button: 'left' },
      }
      const decoy = await authorizeToolUse(
        computerToolUse('ComputerActAtom', decoyInput, 'dangerous-search-decoy'),
        rig.ctx,
        rig.ctx.abortController.signal,
        {
          headless: false,
          safetyChecks: [makeComputerUseSafetyCheck({ sessionManager: rig.mgr })],
        },
      )
      expect(decoy.outcome).toBe('denied')
      if (decoy.outcome !== 'denied') throw new Error('expected fallback ask')
      expect(decoy.decision.decision).toBe('ask')
      expect(decoy.syntheticResult.errorKind).toBe('permission_ask')
      expect(decoy.decision.safetyMetadata).toBeUndefined()
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  })

  // -------------------------------------------------------------------------
  // Fixture #6 — modal overlay blocks a click; verify.ts returns
  // verified:false. After closing the modal, the same click succeeds.
  // -------------------------------------------------------------------------

  it('fixture 6: modal overlay — blocked click does not mutate the page; verify reports no change', async () => {
    const { verify } = await import('../../src/core/computer/verify.js')

    const rig = await setupFixture({
      routes: { [MODAL_HOST]: modalPopupHandler },
      settingsPartial: { allowedDomains: [MODAL_HOST], verifyActions: true },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      const session = rig.mgr.get(sessionId)!
      await rig.tools.navigate.call(
        { sessionId, url: `http://${MODAL_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )

      // Take a "before" capture (ARIA + PNG), click on the Buy button's
      // coordinates (which sit under the modal overlay), then re-capture and
      // run verify. The page's title MUST NOT have changed to "bought" — the
      // overlay swallowed the click.
      const beforeAria = await session.ariaSnapshot(rig.ctx.abortController.signal)
      const beforePng = Buffer.from(
        (await session.screenshot(rig.ctx.abortController.signal)).attachment.data,
        'base64',
      )

      // Buy button sits at left:480 top:368 width:80 height:32 in a 1024x768
      // viewport → center is (520, 384) → normalized (520/1023, 384/767).
      const click = await rig.tools.click.call(
        {
          sessionId,
          x: 520 / 1023,
          y: 384 / 767,
          button: 'left',
        },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(click.isError, click.content).toBe(false)

      const afterAria = await session.ariaSnapshot(rig.ctx.abortController.signal)
      const afterPng = Buffer.from(
        (await session.screenshot(rig.ctx.abortController.signal)).attachment.data,
        'base64',
      )

      const verdict = verify(
        { ariaHash: beforeAria.hash, pngBuffer: beforePng },
        { ariaHash: afterAria.hash, pngBuffer: afterPng },
      )
      expect(verdict.verified).toBe(false)

      // Title should still be "modal" (the page's initial title), NOT "bought".
      expect(await session.currentTitle()).toBe('modal')

      const metrics = rig.mgr.getSessionMetrics(sessionId)
      expect(metrics!.stepCount).toBeGreaterThanOrEqual(2) // navigate + click
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  })

  // -------------------------------------------------------------------------
  // Fixture #7 — infinite scroll. Each scroll mutates the page; the
  // no-progress detector must NOT abort under legitimate scrolling.
  // -------------------------------------------------------------------------

  it('fixture 7: infinite scroll — repeated scrolls mutate the page; no false-positive no-progress abort', async () => {
    const rig = await setupFixture({
      routes: { [SCROLL_HOST]: infiniteScrollHandler },
      settingsPartial: {
        allowedDomains: [SCROLL_HOST],
        // Fallback rule (`verifyActions: false`): aborts only when EVERY
        // available signal stalls. Each scroll moves real pixels, so the
        // pHash ring varies — ARIA may stall (the appended article often
        // sits below the truncation budget) but pHash variation alone is
        // enough to keep the ring from being "fully stalled."
        // This is the canvas-like-change scenario the design calls out.
        verifyActions: false,
        // High maxSteps so the test never reaches the limit organically.
        maxSteps: 50,
      },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      await rig.tools.navigate.call(
        { sessionId, url: `http://${SCROLL_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )

      // Five scrolls. None should trip an abort. We don't care about exact
      // metric values — only that the session is still alive at the end.
      for (let i = 0; i < 5; i++) {
        const r = await rig.tools.scroll.call(
          { sessionId, deltaX: 0, deltaY: 600 },
          rig.ctx,
          rig.ctx.abortController.signal,
        )
        expect(r.isError, `scroll ${i} errored: ${r.content}`).toBe(false)
      }

      const metrics = rig.mgr.getSessionMetrics(sessionId)
      expect(metrics).not.toBeNull()
      expect(metrics!.closeReason).toBeNull() // session still alive
      expect(metrics!.stepCount).toBeGreaterThanOrEqual(6) // navigate + 5 scrolls
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  })

  // -------------------------------------------------------------------------
  // Fixture #8 — prompt-injection adversarial page. Wrapper-bytes proof.
  // -------------------------------------------------------------------------

  it('fixture 8: prompt injection — observation wraps title; closing-tag escape neutralized; atom catalog wrapped; ActAtom drops displayName', async () => {
    const rig = await setupFixture({
      routes: { [INJECT_HOST]: promptInjectionHandler },
      settingsPartial: { allowedDomains: [INJECT_HOST] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      await rig.tools.navigate.call(
        { sessionId, url: `http://${INJECT_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )

      // (a) ComputerObserve wraps URL + title.
      const observeResult = await rig.tools.observe.call(
        { sessionId },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(observeResult.isError).toBe(false)
      expect(observeResult.content).toContain('<untrusted-page-text>')
      expect(observeResult.content).toContain('</untrusted-page-text>')
      expect(observeResult.content).toContain('IGNORE PRIOR INSTRUCTIONS')
      // The literal closing tag in the title must NOT appear unescaped — the
      // wrapper helper rewrites it case-insensitively. The escaped form is
      // `<\/untrusted-page-text>` (per `escapeUntrustedText`).
      expect(observeResult.content).toContain('<\\/untrusted-page-text>')
      // Count tags: exactly one open + one close (the title's literal closing
      // tag must not have produced a second).
      const openCount = (observeResult.content.match(/<untrusted-page-text>/gi) ?? [])
        .length
      const closeCount = (observeResult.content.match(/<\/untrusted-page-text>/gi) ?? [])
        .length
      expect(openCount).toBe(1)
      expect(closeCount).toBe(1)

      // (b) ComputerObserveActions wraps the atom catalog. The hostile
      // aria-label sits inside the delimiter.
      const actionsResult = await rig.tools.observeActions.call(
        { sessionId },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(actionsResult.isError).toBe(false)
      expect(actionsResult.content).toMatch(/<untrusted-page-text>[\s\S]*IGNORE PRIOR INSTRUCTIONS[\s\S]*<\/untrusted-page-text>/)

      // (c) ComputerActAtom drops displayName; the dangerous label must NOT
      // appear in the ActAtom result content (it would otherwise sit in the
      // unwrapped result-prefix territory). Locate the benign atom and act
      // on it. Page resets title to "clicked benign" after the click, but
      // the result text the model receives should be the wrapped observation
      // — the action summary itself omits displayName entirely.
      const session = rig.mgr.get(sessionId)!
      const aria = await session.ariaSnapshot(rig.ctx.abortController.signal)
      const cache = buildAtomCache(aria, session.currentUrl() ?? '')
      session.setAtomCache(cache)
      const benign = [...cache.entries.entries()].find(
        ([, e]) => e.role === 'button',
      )
      expect(benign).toBeDefined()
      const actResult = await rig.tools.actAtom.call(
        {
          sessionId,
          atomId: benign![0],
          action: { type: 'click', button: 'left' },
        },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(actResult.isError).toBe(false)
      // The action-summary prefix (everything BEFORE the wrapped observation)
      // must NOT carry the dangerous label. The full result content can still
      // contain it later — inside the post-action observation's
      // `<untrusted-page-text>` block — because the page text is page-derived.
      // Inspect only the prefix up to the first delimiter.
      const beforeWrap = actResult.content.split('<untrusted-page-text>')[0] ?? ''
      expect(beforeWrap).not.toContain('IGNORE PRIOR INSTRUCTIONS')

      const metrics = rig.mgr.getSessionMetrics(sessionId)
      expect(metrics!.stepCount).toBeGreaterThanOrEqual(2) // navigate + click
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  })

  // -------------------------------------------------------------------------
  // Fixture #9 — slow-load page; stabilization rides through the delay.
  // -------------------------------------------------------------------------

  it('fixture 9: slow load — stabilize waits through a server delay; navigation completes', async () => {
    const delayMs = SLOW_LOAD_DELAY_MS
    const rig = await setupFixture({
      routes: { [SLOW_HOST]: makeSlowLoadHandler({ delayMs }) },
      settingsPartial: { allowedDomains: [SLOW_HOST] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      const session = rig.mgr.get(sessionId)!

      const start = Date.now()
      const navResult = await rig.tools.navigate.call(
        { sessionId, url: `http://${SLOW_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      const elapsed = Date.now() - start
      expect(navResult.isError, navResult.content).toBe(false)
      // Stabilize must have waited ≥ the server delay; allow generous slack
      // since CI machines vary.
      expect(elapsed).toBeGreaterThanOrEqual(delayMs - 500)

      expect(await session.currentTitle()).toBe('slow-loaded')

      const metrics = rig.mgr.getSessionMetrics(sessionId)
      // Step counter is action-count, not clock-time; a single navigate
      // counts as exactly 1 step regardless of how long it took.
      expect(metrics!.stepCount).toBe(1)
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  }, 30_000)

  // -------------------------------------------------------------------------
  // Fixture #10 — download/upload behavioral snapshot.
  // -------------------------------------------------------------------------

  it('fixture 10: downloads/uploads — clicking <a download> does not navigate; upload picker stays unviolated', async () => {
    const rig = await setupFixture({
      routes: { [DOWNLOAD_HOST]: downloadUploadHandler },
      settingsPartial: { allowedDomains: [DOWNLOAD_HOST] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      const session = rig.mgr.get(sessionId)!
      await rig.tools.navigate.call(
        { sessionId, url: `http://${DOWNLOAD_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )

      // Locate the download anchor + the upload input via the atom catalog.
      const aria = await session.ariaSnapshot(rig.ctx.abortController.signal)
      const cache = buildAtomCache(aria, session.currentUrl() ?? '')
      session.setAtomCache(cache)
      const dl = [...cache.entries.entries()].find(
        ([, e]) => e.role === 'link' && e.locatorName === 'Download file',
      )
      const upload = [...cache.entries.values()].find(
        (e) => e.locatorName === 'Upload file',
      )
      expect(dl, 'expected Download link atom').toBeDefined()
      expect(upload, 'expected Upload input atom').toBeDefined()

      // Click the download link. With `acceptDownloads: false` (default in
      // `defaultLaunchChromium` at `playwrightBrowserSession.ts:89`), the
      // document should not navigate.
      const urlBeforeClick = session.currentUrl()
      const titleBeforeClick = await session.currentTitle()
      const dlResult = await rig.tools.actAtom.call(
        {
          sessionId,
          atomId: dl![0],
          action: { type: 'click', button: 'left' },
        },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      // The click itself succeeds; the runtime simply discards the download.
      expect(dlResult.isError, dlResult.content).toBe(false)
      // Behavioral assertion: the page URL + title did not change (the click
      // didn't navigate the document — `acceptDownloads: false` cancels the
      // would-be download navigation). The model would otherwise see a
      // navigation event.
      expect(session.currentUrl()).toBe(urlBeforeClick)
      expect(await session.currentTitle()).toBe(titleBeforeClick)
      // Note: a "no file ended up on disk" assertion would require either a
      // Playwright `downloadsPath` knob (which the runtime doesn't expose) or
      // a scan of OS-default download dirs (flaky and OS-specific).
      // `acceptDownloads: false` is the load-bearing primitive; it is unit-
      // tested where it lives. The behavioral check here is the most honest
      // thing the integration suite can assert about download handling.

      // The upload input is present in the DOM (atom resolved) but no tool
      // surface exposes `setInputFiles`, so it cannot be programmatically
      // driven by Computer-Use without an explicit policy bypass.
      expect(upload).toBeDefined()

      const metrics = rig.mgr.getSessionMetrics(sessionId)
      expect(metrics!.stepCount).toBeGreaterThanOrEqual(2)
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  })

  // -------------------------------------------------------------------------
  // DSF=2 acceptance case — the bridge translation contract round-trips
  // correctly under deviceScaleFactor=2. Uses an inline single-purpose
  // fixture (an absolutely-positioned button with a known pixel offset) so
  // we can assert on the click landing point.
  // -------------------------------------------------------------------------

  it('DSF=2: normalized click lands on a positioned button under deviceScaleFactor=2', async () => {
    const dsfHost = 'dsf.fixture.local'
    const dsfHtml = `<!DOCTYPE html><html><head><title>dsf</title></head><body style="margin:0">
<button id="t" aria-label="Target"
  style="position:absolute;left:480px;top:368px;width:80px;height:32px;">T</button>
<pre id="state">unclicked</pre>
<script>
document.getElementById('t').addEventListener('click', () => {
  document.title = 'clicked';
  document.getElementById('state').textContent = 'clicked';
});
</script></body></html>`

      const rig = await setupFixture({
        routes: {
          [dsfHost]: (_req, res) => {
            res.setHeader('content-type', 'text/html')
            res.end(dsfHtml)
          },
        },
        settingsPartial: { allowedDomains: [dsfHost] },
        deviceScaleFactor: 2,
      })
      activeRig = rig
      try {
        const sessionId = await startSession(rig)
        const session = rig.mgr.get(sessionId)!

        // The mirrored DSF on the BrowserSession's viewport reflects the
        // launch-time override.
        expect(session.viewport.deviceScaleFactor).toBe(2)

        await rig.tools.navigate.call(
          { sessionId, url: `http://${dsfHost}/` },
          rig.ctx,
          rig.ctx.abortController.signal,
        )

        // Button center at viewport (520, 384) → normalized (520/1023, 384/767).
        // Coordinate math is DSF-independent (page.mouse takes CSS px), so the
        // click should land regardless of DSF. This is the bridge translation
        // contract round-trip proof.
        const click = await rig.tools.click.call(
          {
            sessionId,
            x: 520 / 1023,
            y: 384 / 767,
            button: 'left',
          },
          rig.ctx,
          rig.ctx.abortController.signal,
        )
        expect(click.isError, click.content).toBe(false)

        expect(await session.currentTitle()).toBe('clicked')

        // Screenshot at DSF=2 must NOT trip the size validator — Phase 6's
        // `scale: 'css'` keeps the PNG at CSS-pixel dimensions.
        const shot = await session.screenshot(rig.ctx.abortController.signal)
        expect(shot.attachment.width).toBe(1024)
        expect(shot.attachment.height).toBe(768)

        const metrics = rig.mgr.getSessionMetrics(sessionId)
        expect(metrics!.stepCount).toBeGreaterThanOrEqual(2)
      } finally {
        await rig.cleanup()
        activeRig = null
      }
  })

  // ===========================================================================
  // Failure-recovery cases (v3 Phase 6 PR3).
  //
  // Each case reaches further into the runtime than the fixture suite above —
  // a crash test cannot exercise its target through the model-facing tool
  // surface alone. They use minimal inline pages instead of the named
  // fixtures so the failure mode is the focus.
  // ===========================================================================

  // -------------------------------------------------------------------------
  // Failure case 1 — browser crash via SIGKILL on the Chromium child process.
  // The PR1 disconnect handler must wake the SessionManager so the next tool
  // call returns a clean error and `closeReason === 'error'` lands on the
  // metrics snapshot. The kill-signal path is what we actually want to test
  // (a real Chromium crash, not a graceful API close); we fall back to
  // `browser.close()` only if `process()` is unavailable on the runtime
  // (older Playwright versions or wrappers) so the test stays robust without
  // silently weakening to a non-crash simulation.
  // -------------------------------------------------------------------------

  it('failure 1: browser crash via SIGKILL → disconnect handler closes session with reason=error', async () => {
    const crashHost = 'crash.fixture.local'
    const crashHtml = '<!DOCTYPE html><html><head><title>crash</title></head><body><h1>OK</h1></body></html>'
    const rig = await setupFixture({
      routes: {
        [crashHost]: (_req, res) => {
          res.setHeader('content-type', 'text/html')
          res.end(crashHtml)
        },
      },
      settingsPartial: { allowedDomains: [crashHost] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      const session = rig.mgr.get(sessionId)!
      await rig.tools.navigate.call(
        { sessionId, url: `http://${crashHost}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )

      // SIGKILL the Chromium child process — bypasses every clean-shutdown
      // path Playwright provides. The disconnect event then fires when the
      // IPC channel notices its peer is gone, and our handler must take it
      // from there.
      type BrowserHandle = {
        process?: () => { pid?: number } | null
        close: () => Promise<void>
      }
      const browser = (session as unknown as { _browser: BrowserHandle })._browser
      let killed = false
      if (typeof browser.process === 'function') {
        const proc = browser.process()
        if (proc?.pid !== undefined) {
          process.kill(proc.pid, 'SIGKILL')
          killed = true
        }
      }
      if (!killed) {
        // Last-resort fallback: graceful disconnect. Still exercises the
        // disconnect handler but is not a crash; the test docstring above
        // calls this out so a future runtime change doesn't silently weaken.
        await browser.close()
      }

      // Disconnect propagation is asynchronous (Playwright IPC -> 'disconnected'
      // event -> our handler -> requestClose -> closeOnce). Poll briefly for
      // the manager to drop the session; bail with a timeout so a hung run
      // doesn't pretend to pass.
      const start = Date.now()
      while (rig.mgr.get(sessionId) !== undefined && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(rig.mgr.get(sessionId), 'session must be dropped from manager after disconnect').toBeUndefined()

      // Metrics snapshot must reflect 'error' as the close reason — that's
      // the disconnect-handler path (`_requestClose('error')`).
      const metrics = rig.mgr.getSessionMetrics(sessionId)
      expect(metrics).not.toBeNull()
      expect(metrics!.closeReason).toBe('error')
      expect(metrics!.closedAt).not.toBeNull()

      // Subsequent tool calls against the dead session must fail cleanly,
      // not hang or throw something unstructured.
      const next = await rig.tools.navigate.call(
        { sessionId, url: `http://${crashHost}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(next.isError).toBe(true)
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  }, 15_000)

  // -------------------------------------------------------------------------
  // Failure case 2 — fixture server killed mid-navigation. The session must
  // surface a navigation-shaped tool error from `tools.navigate.call` AND
  // remain in a closeable state (server-side error ≠ session error).
  // `ComputerStop` afterwards must record `closeReason: 'stop'` cleanly.
  //
  // We assert on the error SHAPE (errorKind + content matching a
  // navigation/network failure) so an unrelated tool failure that happens
  // to set `isError: true` cannot satisfy the acceptance check.
  // -------------------------------------------------------------------------

  it('failure 2: server killed mid-navigate → navigation_failed error, session stays closeable', async () => {
    // Long delay so the server has time to shut down before responding.
    const rig = await setupFixture({
      routes: { [SLOW_HOST]: makeSlowLoadHandler({ delayMs: 30_000 }) },
      settingsPartial: { allowedDomains: [SLOW_HOST] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      // Fire navigate WITHOUT awaiting; the slow handler is hung server-side
      // and the response will never land.
      const navPromise = rig.tools.navigate.call(
        { sessionId, url: `http://${SLOW_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      // Give navigate ~150ms to start its request, then close the server so
      // the in-flight TCP connection RSTs.
      await new Promise((r) => setTimeout(r, 150))
      await rig.servers.close()

      const navResult = await navPromise
      expect(navResult.isError, 'server kill must surface as a tool error').toBe(true)
      // `BrowserSessionError(kind: 'navigation_failed')` -> `mapBrowserSessionError`
      // -> `errorKind: 'execution_error'` with the navigation-failure prefix.
      // Asserting both the kind AND a navigation/network shape on the
      // content rules out unrelated tool errors that might also set isError.
      expect(navResult.errorKind).toBe('execution_error')
      expect(navResult.content).toMatch(/navigate failed/i)

      // The session itself is still alive — the failure was server-side.
      const liveMetrics = rig.mgr.getSessionMetrics(sessionId)
      expect(liveMetrics!.closeReason).toBeNull()

      // `ComputerStop` should close cleanly without throwing.
      const stop = await rig.tools.stop.call(
        { sessionId },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      expect(stop.isError, stop.content).toBe(false)
      const finalMetrics = rig.mgr.getSessionMetrics(sessionId)
      expect(finalMetrics!.closeReason).toBe('stop')
    } finally {
      await rig.cleanup()
      activeRig = null
    }
  }, 30_000)

  // -------------------------------------------------------------------------
  // Failure case 3 — abort during stabilize.
  //
  // The previous version of this test used `makeSlowLoadHandler` which
  // delays before sending response headers; that means `page.goto(...,
  // waitUntil: 'commit')` blocks waiting for the first response byte and
  // any abort fires DURING goto, not stabilize. The fix: use
  // `makeStabilizeHungHandler` which flushes headers + a partial HTML
  // prefix immediately so `goto` commits, then holds the body open
  // forever — `domcontentloaded` cannot fire, so `stabilize.ts` step 2
  // (`waitForLoadState('domcontentloaded')`) is the load-bearing wait
  // when we abort.
  //
  // Phase 2's `stabilize.ts` registers `signal.addEventListener('abort')`
  // around its load-state wait via `raceAbort(...)`, so a mid-call abort
  // must surface as `errorKind: 'aborted'` immediately — well under the
  // 10s `loadStateTimeoutMs` default.
  // -------------------------------------------------------------------------

  it('failure 3: abort during stabilize → tool returns aborted within 2s', async () => {
    const rig = await setupFixture({
      routes: { [SLOW_HOST]: makeStabilizeHungHandler() },
      settingsPartial: { allowedDomains: [SLOW_HOST] },
    })
    activeRig = rig
    try {
      const sessionId = await startSession(rig)
      // Fire navigate; the handler flushes headers + opens <body> but
      // never closes the response, so `goto(... commit)` resolves quickly
      // and stabilize() then blocks on `domcontentloaded`.
      const navPromise = rig.tools.navigate.call(
        { sessionId, url: `http://${SLOW_HOST}/` },
        rig.ctx,
        rig.ctx.abortController.signal,
      )
      // Wait long enough that the goto has committed and stabilize is
      // running. 250ms is generous on local + CI hardware.
      await new Promise((r) => setTimeout(r, 250))
      const abortAt = Date.now()
      rig.ctx.abortController.abort()

      const navResult = await navPromise
      const elapsed = Date.now() - abortAt
      // The tool must surface the abort, not stabilize's eventual timeout
      // (10s for `domcontentloaded`).
      expect(navResult.isError).toBe(true)
      expect(navResult.errorKind).toBe('aborted')
      // Must be fast — well under stabilize's load-state timeout. Generous
      // slack to tolerate noisy CI machines without false-flagging.
      expect(elapsed).toBeLessThan(2000)

      // `requestClose('aborted')` flowed through the abort listener; the
      // session is gone from the live map and the metrics snapshot records
      // 'aborted' as the reason.
      const metrics = rig.mgr.getSessionMetrics(sessionId)
      expect(metrics!.closeReason).toBe('aborted')
    } finally {
      // The fixture's abortController is already aborted, but `cleanup`
      // calls `mgr.stopAll()` (idempotent) and closes the servers.
      await rig.cleanup()
      activeRig = null
    }
  }, 15_000)

  // `makeDeniedHandler` is exported by the harness for future denied-domain
  // failure cases. Not used by the current suite; this `void` keeps tsc
  // from dropping the import.
  void makeDeniedHandler
})
