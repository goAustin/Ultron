import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  validateComputerUseSettings,
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from './computerUseSettings.js'

// vi.spyOn(process.stderr, 'write') — keep the spy loosely typed; the SDK's
// MockInstance generic doesn't accept the method overload shape directly.
// Same workaround as src/core/providers/warnOnce.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stderrSpy: any

describe('validateComputerUseSettings', () => {
  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  it('returns defaults for undefined input with no warnings', () => {
    const out = validateComputerUseSettings(undefined)
    expect(out).toEqual(defaultComputerUseSettings)
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('returns a fresh viewport object so mutating the result does not poison defaults', () => {
    const out = validateComputerUseSettings(undefined) as ComputerUseSettings
    expect(out.viewport).not.toBe(defaultComputerUseSettings.viewport)
  })

  it('passes a fully-valid input through unchanged', () => {
    const valid = {
      enabled: true,
      defaultEnvironment: 'browser' as const,
      viewport: { width: 1280, height: 720 },
      displaySize: { width: 1024, height: 768 },
      maxSteps: 50,
      maxDurationMs: 600_000,
      maxScreenshotBytes: 3_000_000,
      maxScreenshotDimensions: { width: 1280, height: 800 },
      ariaSnapshotMaxTokens: 8000,
      allowedDomains: ['example.com'],
      deniedDomains: ['evil.com'],
      persistProfiles: true,
      allowDownloads: true,
      allowUploads: true,
      allowAuthHandoff: true,
      debugPersistScreenshots: true,
    }
    const out = validateComputerUseSettings(valid)
    expect(out).toEqual(valid)
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['string', 'not-an-object'],
    ['number', 42],
    ['array', []],
  ])('non-object root (%s) warns once and returns defaults', (_label, raw) => {
    const out = validateComputerUseSettings(raw)
    expect(out).toEqual(defaultComputerUseSettings)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('non-boolean enabled warns and falls back to default false', () => {
    const out = validateComputerUseSettings({ enabled: 'yes' })
    expect(out.enabled).toBe(false)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('out-of-range viewport.width warns and falls back; sibling height is unaffected', () => {
    const out = validateComputerUseSettings({
      viewport: { width: -1, height: 720 },
    })
    expect(out.viewport).toEqual({ width: 1024, height: 720 })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('non-integer viewport.width warns and falls back', () => {
    const out = validateComputerUseSettings({ viewport: { width: 1024.5 } })
    expect(out.viewport.width).toBe(1024)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('non-object viewport warns once and falls back to default object', () => {
    const out = validateComputerUseSettings({ viewport: 'huge' })
    expect(out.viewport).toEqual({ width: 1024, height: 768 })
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('maxSteps = 0 warns and falls back to default 30', () => {
    const out = validateComputerUseSettings({ maxSteps: 0 })
    expect(out.maxSteps).toBe(30)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('maxScreenshotDimensions exceeding the 1280x800 cap warns and falls back', () => {
    const out = validateComputerUseSettings({
      maxScreenshotDimensions: { width: 9999, height: 9999 },
    })
    expect(out.maxScreenshotDimensions).toEqual({ width: 1024, height: 768 })
    expect(stderrSpy).toHaveBeenCalledTimes(2) // one per leaf
  })

  it('maxScreenshotDimensions accepts the cap exactly', () => {
    const out = validateComputerUseSettings({
      maxScreenshotDimensions: { width: 1280, height: 800 },
    })
    expect(out.maxScreenshotDimensions).toEqual({ width: 1280, height: 800 })
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('defaultEnvironment must be browser or desktop', () => {
    const out = validateComputerUseSettings({ defaultEnvironment: 'mobile' })
    expect(out.defaultEnvironment).toBe('browser')
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('allowedDomains: lowercases valid entries and drops bad ones individually', () => {
    const out = validateComputerUseSettings({
      allowedDomains: ['Good.COM', 42, 'bad..com', 'github.com'],
    })
    expect(out.allowedDomains).toEqual(['good.com', 'github.com'])
    expect(stderrSpy).toHaveBeenCalledTimes(2) // one for the number, one for bad..com
  })

  it('non-array allowedDomains warns and falls back to empty list', () => {
    const out = validateComputerUseSettings({ allowedDomains: 'just-one.com' })
    expect(out.allowedDomains).toEqual([])
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('deniedDomains follows the same rules as allowedDomains', () => {
    const out = validateComputerUseSettings({ deniedDomains: ['EVIL.com'] })
    expect(out.deniedDomains).toEqual(['evil.com'])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('one bad leaf does not poison sibling leaves', () => {
    const out = validateComputerUseSettings({
      enabled: 'yes', // bad → default false
      maxSteps: 50, // good → kept
      allowedDomains: ['kept.com'], // good → kept (lowercased)
    })
    expect(out.enabled).toBe(false)
    expect(out.maxSteps).toBe(50)
    expect(out.allowedDomains).toEqual(['kept.com'])
    expect(stderrSpy).toHaveBeenCalledTimes(1) // only `enabled`
  })

  it('non-boolean persistProfiles / allowDownloads / allowUploads / allowAuthHandoff / debugPersistScreenshots all warn and default to false', () => {
    const out = validateComputerUseSettings({
      persistProfiles: 1,
      allowDownloads: 'yes',
      allowUploads: null,
      allowAuthHandoff: 'true',
      debugPersistScreenshots: [],
    })
    expect(out.persistProfiles).toBe(false)
    expect(out.allowDownloads).toBe(false)
    expect(out.allowUploads).toBe(false)
    expect(out.allowAuthHandoff).toBe(false)
    expect(out.debugPersistScreenshots).toBe(false)
    expect(stderrSpy).toHaveBeenCalledTimes(5)
  })
})
