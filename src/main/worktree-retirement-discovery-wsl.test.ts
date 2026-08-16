import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARINE_CREATURES } from '../shared/marine-creatures'
import { createRetiredNameLookup } from '../shared/worktree/retired-name-registry'

const { runWslTranscriptFsTaskMock } = vi.hoisted(() => ({
  runWslTranscriptFsTaskMock: vi.fn()
}))

vi.mock('./native-chat/wsl-transcript-fs-gate', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  runWslTranscriptFsTask: runWslTranscriptFsTaskMock
}))

const { discoverRetiredWorktreeNames } = await import('./worktree-retirement-discovery')
const { WslTranscriptFsError } = await import('./native-chat/wsl-transcript-fs-gate')

const FIRST = MARINE_CREATURES[0].toLowerCase()
const DISTRO_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\orca\\workspaces'

describe('retirement discovery on WSL', () => {
  beforeEach(() => {
    runWslTranscriptFsTaskMock.mockReset()
    // Pass through by default: the gate's own admission logic has its own tests.
    runWslTranscriptFsTaskMock.mockImplementation(
      (_options: unknown, task: (signal: AbortSignal) => Promise<unknown>) =>
        task(new AbortController().signal)
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('admits every WSL UNC listing through the bounded filesystem gate', async () => {
    await discoverRetiredWorktreeNames({
      workspaceRoots: [DISTRO_ROOT],
      home: '/nonexistent-home',
      env: {},
      resolveWslHome: async () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
    })

    // Both UNC reads — the workspace root and the distro's bucket directory — are admitted, at the
    // scan priority that leaves the exact-probe permit free.
    expect(runWslTranscriptFsTaskMock.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ operation: 'readdir', path: DISTRO_ROOT, priority: 'scan' }),
      expect.objectContaining({
        operation: 'readdir',
        path: join('\\\\wsl.localhost\\Ubuntu\\home\\ada', '.claude', 'projects'),
        priority: 'scan'
      })
    ])
  })

  it('leaves no listing ungated when the workspace root is on the Windows side', async () => {
    await discoverRetiredWorktreeNames({
      workspaceRoots: ['C:\\Users\\ada\\orca\\workspaces'],
      home: '/nonexistent-home',
      env: {}
    })

    expect(runWslTranscriptFsTaskMock).not.toHaveBeenCalled()
  })

  it('fails the scan when the gate refuses, rather than memoizing a half-read answer', async () => {
    // A swallowed refusal would cache "nothing is retired" for the process lifetime — the one
    // direction that reissues a cwd whose conversation history is still on the distro.
    runWslTranscriptFsTaskMock.mockRejectedValue(
      new WslTranscriptFsError('timeout', 'filesystem access is taking too long')
    )

    await expect(
      discoverRetiredWorktreeNames({
        workspaceRoots: [DISTRO_ROOT],
        home: '/nonexistent-home',
        env: {},
        resolveWslHome: async () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })
    ).rejects.toBeInstanceOf(WslTranscriptFsError)
  })

  it('keeps a deleted WSL workspace name spent, so the next create cannot reuse its cwd', async () => {
    // Delete/recreate: the workspace directory is gone, but the agent ran inside the distro and its
    // bucket survives there. That bucket is the only remaining evidence the cwd is unsafe.
    const distroHome = await mkdtemp(join(tmpdir(), 'orca-wsl-distro-home-'))
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'orca-wsl-workspaces-'))
    try {
      await mkdir(join(distroHome, '.claude', 'projects', `-home-ada-orca-workspaces-${FIRST}`), {
        recursive: true
      })

      const retired = await discoverRetiredWorktreeNames({
        // The root is listed under its real (empty) path; the UNC spelling supplies the distro.
        workspaceRoots: [DISTRO_ROOT],
        home: workspaceRoot,
        env: {},
        resolveWslHome: async () => distroHome
      })

      expect(retired).toEqual(new Set([FIRST]))
      expect(createRetiredNameLookup({ exhaustedTiers: 0, names: [...retired] })(FIRST)).toBe(true)
    } finally {
      await rm(distroHome, { force: true, recursive: true })
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  })
})
