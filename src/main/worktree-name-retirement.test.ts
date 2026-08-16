import { beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARINE_CREATURES } from '../shared/marine-creatures'
import type { GlobalSettings } from '../shared/global-settings-types'
import type { Repo } from '../shared/repo-types'
import {
  ensureRetiredWorktreeNamesBackfilled,
  getRetiredNameRegistryForRepo,
  normalizeRetirableGeneratedName,
  resetRetirementCollisionKeyCacheForTests
} from './worktree-name-retirement'

const FIRST = MARINE_CREATURES[0].toLowerCase()
const SECOND = MARINE_CREATURES[1].toLowerCase()

const makeRepo = (id: string, path: string): Repo =>
  ({ id, path, displayName: id, badgeColor: '', addedAt: 0 }) as Repo

beforeEach(() => {
  resetRetirementCollisionKeyCacheForTests()
})

describe('normalizeRetirableGeneratedName', () => {
  it('accepts pool names and every numbered tier, not just single digits', () => {
    expect(normalizeRetirableGeneratedName(` ${FIRST} `)).toBe(FIRST)
    expect(normalizeRetirableGeneratedName(`${FIRST}-2`)).toBe(`${FIRST}-2`)
    // Why: the previous `-([2-9]\d*)` never matched these, so a path whose agent history was
    // still on disk got reissued — the exact bug this module exists to prevent.
    expect(normalizeRetirableGeneratedName(`${FIRST}-10`)).toBe(`${FIRST}-10`)
    expect(normalizeRetirableGeneratedName(`${FIRST}-100`)).toBe(`${FIRST}-100`)
  })

  it('rejects legacy repeated suffixes that the canonical collision sequence never emits', () => {
    expect(normalizeRetirableGeneratedName(`${FIRST}-2-3`)).toBeNull()
    expect(normalizeRetirableGeneratedName(`${FIRST}-2-3-4`)).toBeNull()
    expect(normalizeRetirableGeneratedName('fix-login-2-3')).toBeNull()
  })

  it('rejects names outside the pool and absurdly long input', () => {
    expect(normalizeRetirableGeneratedName('fix-login')).toBeNull()
    expect(normalizeRetirableGeneratedName('')).toBeNull()
    expect(normalizeRetirableGeneratedName(`${FIRST}-${'9'.repeat(300)}`)).toBeNull()
  })
})

describe('getRetiredNameRegistryForRepo', () => {
  const settingsFor = (nestWorkspaces: boolean): GlobalSettings =>
    ({ workspaceDir: '/workspaces', nestWorkspaces }) as GlobalSettings
  const storeOf = (byRepo: Record<string, string[]>) => {
    const calls: string[] = []
    return {
      calls,
      mergeRetiredWorktreeNames: () => false,
      getRetiredWorktreeNameRegistry: (repoId: string) => {
        calls.push(repoId)
        return { exhaustedTiers: 0, names: byRepo[repoId] ?? [] }
      }
    }
  }

  it('shares retirements when two repos create into the same cwd namespace', async () => {
    const store = storeOf({ 'repo-a': [FIRST], 'repo-b': [SECOND] })
    const repos = [makeRepo('repo-a', '/repos/a'), makeRepo('repo-b', '/repos/b')]

    expect(
      [
        ...(await getRetiredNameRegistryForRepo(store, repos[1], repos, settingsFor(false))).names
      ].sort()
    ).toEqual([FIRST, SECOND].sort())
  })

  it('keeps independent nested repo paths in separate retirement domains', async () => {
    const store = storeOf({ 'repo-a': [FIRST], 'repo-b': [SECOND] })
    const repos = [makeRepo('repo-a', '/repos/a'), makeRepo('repo-b', '/repos/b')]

    expect(await getRetiredNameRegistryForRepo(store, repos[1], repos, settingsFor(true))).toEqual({
      exhaustedTiers: 0,
      names: [SECOND]
    })
  })

  it('never probes a path for peers that hold no retirements', async () => {
    const pathReads: string[] = []
    const spyRepo = (id: string, path: string): Repo => {
      const repo = makeRepo(id, path)
      return Object.defineProperty(repo, 'path', {
        get: () => {
          pathReads.push(id)
          return path
        }
      }) as Repo
    }
    const store = storeOf({ 'repo-a': [FIRST] })
    const repos = [
      spyRepo('repo-a', '/repos/a'),
      ...Array.from({ length: 20 }, (_unused, index) => spyRepo(`peer-${index}`, `/repos/${index}`))
    ]

    expect(await getRetiredNameRegistryForRepo(store, repos[0], repos, settingsFor(false))).toEqual(
      {
        exhaustedTiers: 0,
        names: [FIRST]
      }
    )
    expect(pathReads.filter((id) => id.startsWith('peer-'))).toEqual([])
  })

  it('reports nothing for a folder workspace, which has no generated worktree names', async () => {
    const store = storeOf({ folder: [FIRST] })
    const folderRepo = { ...makeRepo('folder', '/repos/folder'), kind: 'folder' as const }

    expect(
      (await getRetiredNameRegistryForRepo(store, folderRepo, [folderRepo], settingsFor(false)))
        .names
    ).toEqual([])
  })
})

describe('ensureRetiredWorktreeNamesBackfilled', () => {
  it('awaits the historical workspace scan before returning names to a client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-retirement-backfill-'))
    const workspaceRoot = join(root, 'workspaces')
    await mkdir(join(workspaceRoot, FIRST), { recursive: true })
    const merged: { repoId: string; names: string[] }[] = []
    const store = {
      mergeRetiredWorktreeNames: (repoId: string, names: Iterable<string>) => {
        merged.push({ repoId, names: [...names] })
        return true
      }
    }
    const settings = { workspaceDir: workspaceRoot, nestWorkspaces: false }

    try {
      await ensureRetiredWorktreeNamesBackfilled(store, makeRepo('repo-a', '/repos/a'), settings)
      expect(merged).toEqual([{ repoId: 'repo-a', names: [FIRST] }])

      // Why: the scan is cached per cwd namespace but the registry is per repo, so a second repo in
      // the same namespace must still receive the merge rather than silently inheriting nothing.
      await ensureRetiredWorktreeNamesBackfilled(store, makeRepo('repo-b', '/repos/b'), settings)
      expect(merged).toEqual([
        { repoId: 'repo-a', names: [FIRST] },
        { repoId: 'repo-b', names: [FIRST] }
      ])
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('skips repos whose agent state lives on another host', async () => {
    const merged: string[] = []
    const store = {
      mergeRetiredWorktreeNames: (_repoId: string, names: Iterable<string>) => {
        merged.push(...names)
        return true
      }
    }
    const sshRepo = { ...makeRepo('repo-ssh', '/remote/repo'), connectionId: 'ssh-1' }

    await ensureRetiredWorktreeNamesBackfilled(store, sshRepo, {
      workspaceDir: '/workspaces',
      nestWorkspaces: false
    })

    expect(merged).toEqual([])
  })
})
