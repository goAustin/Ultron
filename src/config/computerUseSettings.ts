/**
 * v3 Phase 0: validator and defaults for the `computerUse` settings section.
 *
 * Pure module — no I/O. Contract is the same as `src/web/rulesSeed.ts`:
 * "boot must never throw". Invalid leaves warn to stderr and fall back to
 * the per-field default. Sibling leaves are independent: one bad value does
 * not poison the rest.
 *
 * Input is `unknown` (not `ComputerUseSettingsInput | undefined`) because
 * `readSettingsConfig()` casts parsed JSON without runtime validation —
 * `settings.computerUse` may be a string, null, array, or any JSON value.
 *
 * Phase 0 only ships the validator + boot-time invocation in `QueryEngine`.
 * The result is discarded today; Phase 3 will store it where the conditional
 * registry can read it for tool gating. See `docs/ultron_v3/v3-phase0-design.md`.
 */

import { isValidDomainPattern } from '../web/domainPolicy.js'

export type ComputerUseSettings = {
  enabled: boolean
  defaultEnvironment: 'browser' | 'desktop'
  viewport: { width: number; height: number }
  displaySize: { width: number; height: number }
  maxSteps: number
  maxDurationMs: number
  maxScreenshotBytes: number
  maxScreenshotDimensions: { width: number; height: number }
  ariaSnapshotMaxTokens: number
  allowedDomains: readonly string[]
  deniedDomains: readonly string[]
  persistProfiles: boolean
  allowDownloads: boolean
  allowUploads: boolean
  allowAuthHandoff: boolean
  debugPersistScreenshots: boolean
}

export const defaultComputerUseSettings: ComputerUseSettings = {
  enabled: false,
  defaultEnvironment: 'browser',
  viewport: { width: 1024, height: 768 },
  displaySize: { width: 1024, height: 768 },
  maxSteps: 30,
  maxDurationMs: 300_000,
  maxScreenshotBytes: 2_000_000,
  maxScreenshotDimensions: { width: 1024, height: 768 },
  ariaSnapshotMaxTokens: 4000,
  allowedDomains: [],
  deniedDomains: [],
  persistProfiles: false,
  allowDownloads: false,
  allowUploads: false,
  allowAuthHandoff: false,
  debugPersistScreenshots: false,
}

const VIEWPORT_MAX = 4096
// Hard cap from the v3 plan (Anthropic accuracy guidance, XGA-class).
const SCREENSHOT_DIM_CAP_W = 1280
const SCREENSHOT_DIM_CAP_H = 800

function warn(msg: string): void {
  process.stderr.write(`[ultron] settings.json: ${msg}\n`)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function describeKind(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function validateBoolean(v: unknown, field: string, dflt: boolean): boolean {
  if (v === undefined) return dflt
  if (typeof v !== 'boolean') {
    warn(`computerUse.${field} must be boolean; got ${describeKind(v)}; using default`)
    return dflt
  }
  return v
}

function validateInteger(
  v: unknown,
  field: string,
  dflt: number,
  min: number,
  max: number,
): number {
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    warn(`computerUse.${field} must be an integer; got ${describeKind(v)}; using default`)
    return dflt
  }
  if (v < min || v > max) {
    warn(`computerUse.${field} = ${v} out of range [${min}, ${max}]; using default`)
    return dflt
  }
  return v
}

function validateDimensions(
  v: unknown,
  field: string,
  dflt: { width: number; height: number },
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  if (v === undefined) return { ...dflt }
  if (!isPlainObject(v)) {
    warn(`computerUse.${field} must be an object; got ${describeKind(v)}; using default`)
    return { ...dflt }
  }
  return {
    width: validateInteger(v.width, `${field}.width`, dflt.width, 1, maxW),
    height: validateInteger(v.height, `${field}.height`, dflt.height, 1, maxH),
  }
}

function validateEnvironment(v: unknown): 'browser' | 'desktop' {
  if (v === undefined) return defaultComputerUseSettings.defaultEnvironment
  if (v === 'browser' || v === 'desktop') return v
  warn(
    `computerUse.defaultEnvironment must be "browser" or "desktop"; got ${JSON.stringify(v)}; using default`,
  )
  return defaultComputerUseSettings.defaultEnvironment
}

function validateDomainList(v: unknown, field: string): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    warn(`computerUse.${field} must be an array; got ${describeKind(v)}; using empty list`)
    return []
  }
  const out: string[] = []
  for (let i = 0; i < v.length; i++) {
    const entry = v[i]
    if (typeof entry !== 'string') {
      warn(`computerUse.${field}[${i}] is not a string; skipping`)
      continue
    }
    const lowered = entry.toLowerCase()
    if (!isValidDomainPattern(lowered)) {
      warn(`computerUse.${field}[${i}] = ${JSON.stringify(entry)} is not a valid host pattern; skipping`)
      continue
    }
    out.push(lowered)
  }
  return out
}

export function validateComputerUseSettings(raw: unknown): ComputerUseSettings {
  if (raw === undefined) {
    return {
      ...defaultComputerUseSettings,
      viewport: { ...defaultComputerUseSettings.viewport },
      displaySize: { ...defaultComputerUseSettings.displaySize },
      maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
      allowedDomains: [],
      deniedDomains: [],
    }
  }
  if (!isPlainObject(raw)) {
    warn(`computerUse must be an object; got ${describeKind(raw)}; using defaults`)
    return {
      ...defaultComputerUseSettings,
      viewport: { ...defaultComputerUseSettings.viewport },
      displaySize: { ...defaultComputerUseSettings.displaySize },
      maxScreenshotDimensions: { ...defaultComputerUseSettings.maxScreenshotDimensions },
      allowedDomains: [],
      deniedDomains: [],
    }
  }

  return {
    enabled: validateBoolean(raw.enabled, 'enabled', defaultComputerUseSettings.enabled),
    defaultEnvironment: validateEnvironment(raw.defaultEnvironment),
    viewport: validateDimensions(
      raw.viewport,
      'viewport',
      defaultComputerUseSettings.viewport,
      VIEWPORT_MAX,
      VIEWPORT_MAX,
    ),
    displaySize: validateDimensions(
      raw.displaySize,
      'displaySize',
      defaultComputerUseSettings.displaySize,
      VIEWPORT_MAX,
      VIEWPORT_MAX,
    ),
    maxSteps: validateInteger(
      raw.maxSteps,
      'maxSteps',
      defaultComputerUseSettings.maxSteps,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxDurationMs: validateInteger(
      raw.maxDurationMs,
      'maxDurationMs',
      defaultComputerUseSettings.maxDurationMs,
      1000,
      Number.MAX_SAFE_INTEGER,
    ),
    maxScreenshotBytes: validateInteger(
      raw.maxScreenshotBytes,
      'maxScreenshotBytes',
      defaultComputerUseSettings.maxScreenshotBytes,
      1024,
      Number.MAX_SAFE_INTEGER,
    ),
    maxScreenshotDimensions: validateDimensions(
      raw.maxScreenshotDimensions,
      'maxScreenshotDimensions',
      defaultComputerUseSettings.maxScreenshotDimensions,
      SCREENSHOT_DIM_CAP_W,
      SCREENSHOT_DIM_CAP_H,
    ),
    ariaSnapshotMaxTokens: validateInteger(
      raw.ariaSnapshotMaxTokens,
      'ariaSnapshotMaxTokens',
      defaultComputerUseSettings.ariaSnapshotMaxTokens,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    allowedDomains: validateDomainList(raw.allowedDomains, 'allowedDomains'),
    deniedDomains: validateDomainList(raw.deniedDomains, 'deniedDomains'),
    persistProfiles: validateBoolean(
      raw.persistProfiles,
      'persistProfiles',
      defaultComputerUseSettings.persistProfiles,
    ),
    allowDownloads: validateBoolean(
      raw.allowDownloads,
      'allowDownloads',
      defaultComputerUseSettings.allowDownloads,
    ),
    allowUploads: validateBoolean(
      raw.allowUploads,
      'allowUploads',
      defaultComputerUseSettings.allowUploads,
    ),
    allowAuthHandoff: validateBoolean(
      raw.allowAuthHandoff,
      'allowAuthHandoff',
      defaultComputerUseSettings.allowAuthHandoff,
    ),
    debugPersistScreenshots: validateBoolean(
      raw.debugPersistScreenshots,
      'debugPersistScreenshots',
      defaultComputerUseSettings.debugPersistScreenshots,
    ),
  }
}
