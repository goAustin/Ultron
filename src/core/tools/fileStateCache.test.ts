import { describe, it, expect } from 'vitest'
import { markRead, hasBeenRead, getReadState } from './fileStateCache.js'
import type { ReadFileState } from './context.js'

describe('fileStateCache', () => {
  function makeState(): ReadFileState {
    return new Map()
  }

  it('hasBeenRead returns false for unknown path', () => {
    expect(hasBeenRead(makeState(), '/foo.ts')).toBe(false)
  })

  it('hasBeenRead returns true after markRead', () => {
    const state = makeState()
    markRead(state, '/foo.ts', 'hello', 1000)
    expect(hasBeenRead(state, '/foo.ts')).toBe(true)
  })

  it('getReadState returns undefined for unknown path', () => {
    expect(getReadState(makeState(), '/foo.ts')).toBeUndefined()
  })

  it('getReadState returns stored values', () => {
    const state = makeState()
    markRead(state, '/foo.ts', 'hello world', 42)
    expect(getReadState(state, '/foo.ts')).toEqual({ content: 'hello world', mtime: 42 })
  })

  it('markRead overwrites previous entry', () => {
    const state = makeState()
    markRead(state, '/foo.ts', 'v1', 100)
    markRead(state, '/foo.ts', 'v2', 200)
    expect(getReadState(state, '/foo.ts')).toEqual({ content: 'v2', mtime: 200 })
  })

  it('tracks multiple files independently', () => {
    const state = makeState()
    markRead(state, '/a.ts', 'aaa', 1)
    markRead(state, '/b.ts', 'bbb', 2)
    expect(hasBeenRead(state, '/a.ts')).toBe(true)
    expect(hasBeenRead(state, '/b.ts')).toBe(true)
    expect(getReadState(state, '/a.ts')!.content).toBe('aaa')
    expect(getReadState(state, '/b.ts')!.content).toBe('bbb')
  })
})
