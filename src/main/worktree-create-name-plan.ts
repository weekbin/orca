import {
  getGeneratedWorktreeCreateCandidate,
  getWorktreeCreateCandidate,
  isGeneratedWorktreeCreateName
} from './worktree-create-candidates'
import type { RetiredNameRegistry } from '../shared/worktree/retired-name-registry'
import { createRetiredNameLookup } from '../shared/worktree/retired-name-registry'

export type WorktreeCreateNameCandidate = {
  /** Filesystem-safe name; drives the workspace path and branch. */
  sanitizedName: string
  /** Display name the workspace is labelled with. */
  requestedName: string
}

export type WorktreeCreateNamePlan = {
  /** True when the created name must be recorded as spent once creation commits. */
  readonly retiresCreatedName: boolean
  /** Null when this suffix lands on a retired cwd; the caller skips it without spending an attempt. */
  candidateAt(suffix: number): WorktreeCreateNameCandidate | null
}

export type WorktreeCreateNamePlanArgs = {
  sanitizedName: string
  /** The raw name the caller asked for; empty falls back to the sanitized candidate. */
  requestedName: string
  /** Set only by clients that know the name came from the creature-name generator. */
  nameWasGenerated: boolean | undefined
  loadRetiredNames: () => Promise<RetiredNameRegistry>
}

/** Resolves what a create attempt may call itself, shared by the three create paths (local IPC, SSH,
 *  runtime) so a retirement rule cannot hold on one and not the others.
 *
 *  Two decisions, deliberately split — PR #14350 conflated them, and STA-4471 is the fallout:
 *
 *  - *Whether to walk the creature tier ladder* stays gated on the client's `nameWasGenerated` bit.
 *    A name the user typed keeps its literal spelling and its plain `-2`, `-3` suffixes.
 *  - *Whether a retired cwd may be reused* is decided by the host alone. An older paired or mobile
 *    client omits the provenance bit entirely, and gating on it let those clients recreate a
 *    workspace at a path the host already knows holds the previous occupant's Claude/Codex history.
 *
 *  Consulting the retired set — names actually spent — rather than the whole generator pool is what
 *  makes host-side enforcement safe. The pool is ordinary English (`orca`, `runner`, `emperor`), so
 *  matching against it would hijack deliberate names; the retired set only ever names cwds this host
 *  issued, where redirecting is the whole point. A name outside the pool can never be retired, so it
 *  never even loads the registry. */
export async function planWorktreeCreateNames(
  args: WorktreeCreateNamePlanArgs
): Promise<WorktreeCreateNamePlan> {
  const isPoolShaped = isGeneratedWorktreeCreateName(args.sanitizedName)
  const usesGeneratedLadder = args.nameWasGenerated === true && isPoolShaped
  const registry = isPoolShaped ? await args.loadRetiredNames() : null
  const isRetiredName = registry ? createRetiredNameLookup(registry) : null
  const trimmedRequestedName = args.requestedName.trim()
  return {
    retiresCreatedName: isPoolShaped,
    candidateAt(suffix) {
      // Skipping is pure string math, so a run of retired tiers costs no I/O and no attempt budget.
      const sanitizedName = usesGeneratedLadder
        ? getGeneratedWorktreeCreateCandidate(args.sanitizedName, suffix, registry?.exhaustedTiers)
        : getWorktreeCreateCandidate(args.sanitizedName, suffix)
      if (isRetiredName?.(sanitizedName)) {
        return null
      }
      return {
        sanitizedName,
        requestedName:
          !usesGeneratedLadder && trimmedRequestedName
            ? getWorktreeCreateCandidate(args.requestedName, suffix)
            : sanitizedName
      }
    }
  }
}
