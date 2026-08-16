import { describe, expect, it, vi } from 'vitest'
import { planWorktreeCreateNames } from './worktree-create-name-plan'
import {
  EMPTY_RETIRED_NAME_REGISTRY,
  type RetiredNameRegistry
} from '../shared/worktree/retired-name-registry'

function plan(args: {
  sanitizedName: string
  requestedName?: string
  nameWasGenerated?: boolean
  retired?: RetiredNameRegistry
}): ReturnType<typeof planWorktreeCreateNames> {
  return planWorktreeCreateNames({
    sanitizedName: args.sanitizedName,
    requestedName: args.requestedName ?? args.sanitizedName,
    nameWasGenerated: args.nameWasGenerated,
    loadRetiredNames: async () => args.retired ?? EMPTY_RETIRED_NAME_REGISTRY
  })
}

/** The candidate ladder, with retired rungs dropped the way the create loops drop them. */
function walk(
  namePlan: Awaited<ReturnType<typeof planWorktreeCreateNames>>,
  suffixes: number
): string[] {
  const taken: string[] = []
  for (let suffix = 1; suffix <= suffixes; suffix += 1) {
    const candidate = namePlan.candidateAt(suffix)
    if (candidate) {
      taken.push(candidate.sanitizedName)
    }
  }
  return taken
}

describe('planWorktreeCreateNames', () => {
  it('refuses a retired cwd even when the client sends no provenance bit', async () => {
    const namePlan = await plan({
      sanitizedName: 'nautilus',
      retired: { exhaustedTiers: 0, names: ['nautilus'] }
    })

    expect(namePlan.candidateAt(1)).toBeNull()
    expect(namePlan.candidateAt(2)).toEqual({
      sanitizedName: 'nautilus-2',
      requestedName: 'nautilus-2'
    })
  })

  it('never loads the registry for a name the generator could not have produced', async () => {
    const loadRetiredNames = vi.fn(async () => ({ exhaustedTiers: 0, names: ['fix-login'] }))

    const namePlan = await planWorktreeCreateNames({
      sanitizedName: 'fix-login',
      requestedName: 'fix-login',
      nameWasGenerated: undefined,
      loadRetiredNames
    })

    expect(loadRetiredNames).not.toHaveBeenCalled()
    expect(namePlan.retiresCreatedName).toBe(false)
    expect(walk(namePlan, 2)).toEqual(['fix-login', 'fix-login-2'])
  })

  it('keeps a typed name literal instead of canonicalizing it onto the tier ladder', async () => {
    // `nautilus-2-3` is a legacy repeat-suffixed spelling. The generated ladder folds it to
    // `nautilus-4`; a name the user typed must keep the directory it asked for.
    const typed = await plan({ sanitizedName: 'nautilus-2-3' })
    const generated = await plan({ sanitizedName: 'nautilus-2-3', nameWasGenerated: true })

    expect(walk(typed, 2)).toEqual(['nautilus-2-3', 'nautilus-2-3-2'])
    expect(walk(generated, 2)).toEqual(['nautilus-4', 'nautilus-5'])
  })

  it('keeps the display name suffixed alongside a typed name it had to redirect', async () => {
    const namePlan = await plan({
      sanitizedName: 'nautilus',
      requestedName: 'Nautilus',
      retired: { exhaustedTiers: 0, names: ['nautilus'] }
    })

    expect(namePlan.candidateAt(2)).toEqual({
      sanitizedName: 'nautilus-2',
      requestedName: 'Nautilus-2'
    })
  })

  it('starts a generated name past the compaction watermark rather than walking every spent tier', async () => {
    const namePlan = await plan({
      sanitizedName: 'nautilus',
      nameWasGenerated: true,
      retired: { exhaustedTiers: 3, names: [] }
    })

    expect(walk(namePlan, 2)).toEqual(['nautilus-4', 'nautilus-5'])
  })

  it('records a pool-shaped name as spent however the client labelled it', async () => {
    await expect(plan({ sanitizedName: 'nautilus' })).resolves.toMatchObject({
      retiresCreatedName: true
    })
    await expect(
      plan({ sanitizedName: 'nautilus', nameWasGenerated: true })
    ).resolves.toMatchObject({ retiresCreatedName: true })
  })
})
