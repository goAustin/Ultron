import { describe, expect, it } from 'vitest'

import { selectShellInvocation } from './shellInvocation.js'

describe('selectShellInvocation', () => {
  it('returns PowerShell on win32', () => {
    expect(selectShellInvocation('win32')).toEqual({
      executable: 'powershell.exe',
      argFlag: '-Command',
    })
  })

  it('returns /bin/bash on darwin', () => {
    expect(selectShellInvocation('darwin')).toEqual({
      executable: '/bin/bash',
      argFlag: '-c',
    })
  })

  it('returns /bin/bash on linux', () => {
    expect(selectShellInvocation('linux')).toEqual({
      executable: '/bin/bash',
      argFlag: '-c',
    })
  })

  it('returns /bin/bash on other unix-like platforms', () => {
    expect(selectShellInvocation('freebsd')).toEqual({
      executable: '/bin/bash',
      argFlag: '-c',
    })
  })
})
