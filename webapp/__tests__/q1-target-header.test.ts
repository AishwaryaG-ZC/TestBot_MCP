import { describe, it, expect } from 'vitest'
import { gitRemoteUrl } from '@/components/test-run/TargetAppHeader'

/**
 * Q1: TargetAppHeader's git-remote URL helper.
 *
 * Pure logic only (the component itself uses React hooks; full render tests
 * would require @testing-library/react which isn't installed yet). We
 * exercise the URL builder which is the only non-trivial bit.
 */

describe('Q1: gitRemoteUrl', () => {
  it('returns http(s) URLs unchanged', () => {
    expect(gitRemoteUrl('https://github.com/foo/bar')).toBe('https://github.com/foo/bar')
    expect(gitRemoteUrl('http://gitlab.local/x/y')).toBe('http://gitlab.local/x/y')
  })
  it('converts git@ SSH form to https URL', () => {
    expect(gitRemoteUrl('git@github.com:foo/bar.git')).toBe('https://github.com/foo/bar')
    expect(gitRemoteUrl('git@gitlab.com:org/proj')).toBe('https://gitlab.com/org/proj')
  })
  it('converts bare github.com/owner/repo to https URL', () => {
    expect(gitRemoteUrl('github.com/shreyespd/thea')).toBe('https://github.com/shreyespd/thea')
  })
  it('returns null when format is unrecognized', () => {
    expect(gitRemoteUrl('just a name')).toBeNull()
    expect(gitRemoteUrl('')).toBeNull()
  })
})
