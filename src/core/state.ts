/**
 * Generic mutable state store — synchronous, single-instance.
 * No external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Listener<T> = (state: T, prev: T) => void
export type Unsubscribe = () => void

export interface Store<T> {
  getState(): T
  setState(partial: Partial<T> | ((prev: T) => Partial<T> | T)): void
  subscribe(listener: Listener<T>): Unsubscribe
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStore<T extends Record<string, unknown>>(initial: T): Store<T> {
  let state: T = initial
  const listeners = new Set<Listener<T>>()

  return {
    getState(): T {
      return state
    },

    setState(partial: Partial<T> | ((prev: T) => Partial<T> | T)): void {
      const prev = state
      const next = typeof partial === 'function' ? partial(prev) : partial
      state = { ...prev, ...next }
      for (const listener of listeners) {
        listener(state, prev)
      }
    },

    subscribe(listener: Listener<T>): Unsubscribe {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// ---------------------------------------------------------------------------
// AppState — minimal for Phase 2, grows in later phases
// ---------------------------------------------------------------------------

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

export type AppState = {
  readonly permissionMode: PermissionMode
  readonly permissionRules: import('./permissions/types.js').PermissionRule[]
  readonly workingDirectories: readonly string[]
}

export function getDefaultAppState(): AppState {
  return { permissionMode: 'default', permissionRules: [], workingDirectories: [] }
}
