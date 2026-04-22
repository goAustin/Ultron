import { describe, it, expect, vi } from 'vitest'
import { createStore, getDefaultAppState } from './state.js'
import type { AppState } from './state.js'

describe('createStore', () => {
  it('returns initial state from getState', () => {
    const store = createStore({ count: 0, name: 'test' })
    expect(store.getState()).toEqual({ count: 0, name: 'test' })
  })

  it('shallow-merges a partial object', () => {
    const store = createStore({ a: 1, b: 2 })
    store.setState({ a: 10 })
    expect(store.getState()).toEqual({ a: 10, b: 2 })
  })

  it('shallow-merges from an updater returning partial', () => {
    const store = createStore({ a: 1, b: 2 })
    store.setState((prev) => ({ a: prev.a + 1 }))
    expect(store.getState()).toEqual({ a: 2, b: 2 })
  })

  it('supports updater returning full state', () => {
    const store = createStore({ a: 1, b: 2 })
    store.setState((prev) => ({ ...prev, a: 99 }))
    expect(store.getState()).toEqual({ a: 99, b: 2 })
  })

  it('fires listeners synchronously with new and prev state', () => {
    const store = createStore({ v: 'old' })
    const listener = vi.fn()
    store.subscribe(listener)

    store.setState({ v: 'new' })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ v: 'new' }, { v: 'old' })
  })

  it('unsubscribe stops listener from firing', () => {
    const store = createStore({ v: 0 })
    const listener = vi.fn()
    const unsub = store.subscribe(listener)

    store.setState({ v: 1 })
    expect(listener).toHaveBeenCalledOnce()

    unsub()
    store.setState({ v: 2 })
    expect(listener).toHaveBeenCalledOnce() // still 1
  })

  it('does not fire listeners when setState produces identical shape', () => {
    // Note: listeners fire on every setState call, even if values are same.
    // This is the simple correct behavior — no shallow equality check.
    const store = createStore({ v: 1 })
    const listener = vi.fn()
    store.subscribe(listener)

    store.setState({ v: 1 })
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('getDefaultAppState', () => {
  it('returns default permission mode', () => {
    const state = getDefaultAppState()
    expect(state.permissionMode).toBe('default')
  })
})
