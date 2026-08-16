import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS,
  RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS,
  runRetirementBackfillScan
} from './worktree-retirement-backfill-scan'

/** A scan the test settles by hand, standing in for a `readdir` on a stalled NFS/SMB/WSL mount. */
function stallingScan(): { run: () => Promise<Set<string>>; finish: (names: string[]) => void } {
  let settle: (names: Set<string>) => void = () => {}
  return {
    run: () => new Promise<Set<string>>((resolve) => (settle = resolve)),
    finish: (names) => settle(new Set(names))
  }
}

describe('runRetirementBackfillScan', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a listing that never returns instead of blocking create forever', async () => {
    const scan = stallingScan()

    const names = runRetirementBackfillScan({}, 'ns', scan.run)
    const settled = expect(names).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)

    await settled
  })

  it('retries a timed-out namespace once its backoff lapses, rather than wedging until restart', async () => {
    const store = {}
    const first = stallingScan()
    const second = vi.fn(async () => new Set(['nautilus']))

    const stalled = runRetirementBackfillScan(store, 'ns', first.run)
    const settled = expect(stalled).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    await settled

    // Why the backoff: an unabortable `readdir` still holds a libuv thread, so re-probing on every
    // create would starve the pool. Until it lapses the failure is served from the memo.
    await expect(runRetirementBackfillScan(store, 'ns', second)).rejects.toThrow(/exceeded/)
    expect(second).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS)
    await expect(runRetirementBackfillScan(store, 'ns', second)).resolves.toEqual(
      new Set(['nautilus'])
    )
  })

  it('scans a namespace once and shares the answer with every later caller', async () => {
    const store = {}
    const scan = vi.fn(async () => new Set(['nautilus']))

    await expect(runRetirementBackfillScan(store, 'ns', scan)).resolves.toEqual(
      new Set(['nautilus'])
    )
    await expect(runRetirementBackfillScan(store, 'ns', scan)).resolves.toEqual(
      new Set(['nautilus'])
    )

    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('keeps one namespace stall from failing another', async () => {
    const store = {}
    const stuck = stallingScan()
    const healthy = vi.fn(async () => new Set(['nautilus']))

    const stalled = runRetirementBackfillScan(store, 'stuck-ns', stuck.run)
    const settled = expect(stalled).rejects.toThrow(/exceeded/)
    await vi.advanceTimersByTimeAsync(RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    await settled

    await expect(runRetirementBackfillScan(store, 'healthy-ns', healthy)).resolves.toEqual(
      new Set(['nautilus'])
    )
  })

  it('does not let one store inherit another store scan memo', async () => {
    const first = vi.fn(async () => new Set(['nautilus']))
    const second = vi.fn(async () => new Set(['orca']))

    await runRetirementBackfillScan({}, 'ns', first)
    await expect(runRetirementBackfillScan({}, 'ns', second)).resolves.toEqual(new Set(['orca']))
  })
})
