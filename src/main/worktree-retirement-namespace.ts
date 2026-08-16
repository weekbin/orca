import { getRepoExecutionHostId, parseExecutionHostId } from '../shared/execution-host'
import {
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../shared/worktree/retired-name-registry'
import type { Repo } from '../shared/repo-types'
import { worktreePathComparisonKey } from './ipc/worktree-path-comparison'
import { sshEndpointKey, type SshIdentityFields } from './ssh/ssh-target-identity'

/**
 * Keys for `retiredWorktreeNamesByNamespace`, the copy of the retirement registry that survives a
 * project being removed and re-added.
 *
 * Primary storage stays on `repo.id` (see worktree-name-retirement.ts): the namespace is derived
 * from settings that a user can toggle at any time, so keying storage on it would orphan every
 * affected repo's retirements on a settings change. This map is the second, path-derived copy —
 * a settings toggle changes this key but `repo.id` still holds the tombstone, and a remove/re-add
 * loses the `repo.id` row but this key still matches.
 */

type RepoHostFields = Pick<Repo, 'connectionId' | 'executionHostId'>

export type SshTargetLookup = (targetId: string) => SshIdentityFields | undefined

/** No target row means no way to tell endpoints apart. The retirement contract prefers
 *  over-retiring (one name out of a 552-name pool) to reissuing a path whose agent history is
 *  still there, so unresolvable SSH repos share a bucket — still split by workspace path. */
export const UNKNOWN_SSH_HOST_IDENTITY = 'ssh:?'

/** Which machine and account a repo creates workspaces on. SSH resolves to the endpoint tuple
 *  rather than the target row id, because a removed and re-added host mints a fresh id while
 *  reaching the same filesystem. */
export function retirementHostIdentity(repo: RepoHostFields, lookup?: SshTargetLookup): string {
  const hostId = getRepoExecutionHostId(repo)
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind !== 'ssh') {
    return hostId
  }
  const target = lookup?.(parsed.targetId)
  return target ? sshHostIdentity(target) : UNKNOWN_SSH_HOST_IDENTITY
}

export function sshHostIdentity(target: SshIdentityFields): string {
  return `ssh:${sshEndpointKey(target)}`
}

export function retirementNamespaceKey(hostIdentity: string, probePath: string): string {
  return `${hostIdentity}:${worktreePathComparisonKey(probePath)}`
}

/** Rewrites a key's host identity, keeping its workspace-path half. Returns null when the key is
 *  not under `fromIdentity` or the swap is a no-op. */
function swapRetirementNamespaceHost(
  namespaceKey: string,
  fromIdentity: string,
  toIdentity: string
): string | null {
  const prefix = `${fromIdentity}:`
  return fromIdentity !== toIdentity && namespaceKey.startsWith(prefix)
    ? `${toIdentity}:${namespaceKey.slice(prefix.length)}`
    : null
}

/** The canonical key plus its pre-identity twin, whose host half was the SSH target row id. Reads
 *  cover both so an upgrade keeps the tombstones it already wrote; writes only use the first. */
export function retirementNamespaceKeysToRead(
  repo: RepoHostFields,
  namespaceKey: string,
  lookup?: SshTargetLookup
): string[] {
  const legacyKey = swapRetirementNamespaceHost(
    namespaceKey,
    retirementHostIdentity(repo, lookup),
    getRepoExecutionHostId(repo)
  )
  return legacyKey ? [namespaceKey, legacyKey] : [namespaceKey]
}

/** The map deliberately outlives the repos that wrote it — that is what makes a re-add recover its
 *  tombstones — so nothing prunes it per repo. It is capped instead. */
const MAX_RETIREMENT_NAMESPACES = 256

export function recordRetirementNamespaceRegistry(
  namespaces: Record<string, RetiredNameRegistry>,
  namespaceKey: string,
  registry: RetiredNameRegistry
): void {
  // Re-inserting moves the key to the end: JS keeps non-numeric string keys in insertion order and
  // JSON round-trips it, so the object's own order is the LRU list — no timestamp to persist.
  delete namespaces[namespaceKey]
  namespaces[namespaceKey] = registry
  const keys = Object.keys(namespaces)
  for (const stale of keys.slice(0, keys.length - MAX_RETIREMENT_NAMESPACES)) {
    delete namespaces[stale]
  }
}

/** Re-keys every namespace an SSH target used to own onto its current identity, so a rotated
 *  target id does not strand the names it already spent. */
export function migrateRetirementNamespaceHostIdentity(
  namespaces: Record<string, RetiredNameRegistry> | undefined,
  oldHostIdentities: readonly string[],
  newHostIdentity: string
): boolean {
  if (!namespaces) {
    return false
  }
  let changed = false
  for (const oldIdentity of new Set(oldHostIdentities)) {
    if (!oldIdentity || oldIdentity === newHostIdentity) {
      continue
    }
    const prefix = `${oldIdentity}:`
    for (const key of Object.keys(namespaces)) {
      if (!key.startsWith(prefix)) {
        continue
      }
      const registry = namespaces[key]
      delete namespaces[key]
      const nextKey = `${newHostIdentity}:${key.slice(prefix.length)}`
      const existing = namespaces[nextKey]
      namespaces[nextKey] = existing ? mergeRetiredNameRegistries(existing, registry) : registry
      changed = true
    }
  }
  return changed
}
