/** Deadline for one retirement discovery scan. Generated create awaits it, so it has to be short
 *  enough that a stalled NFS/SMB/WSL listing degrades to "seed nothing" instead of a frozen create. */
export const RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS = 15_000

/** How long a failed scan stays failed. Retrying immediately would let every create start another
 *  listing against the same stalled mount, and an unabortable `readdir` holds a libuv threadpool
 *  thread until the OS releases it — four of those and the whole process loses filesystem access. */
export const RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS = 60_000

type BackfillScan = {
  /** Resolves with the discovered names, or rejects once the deadline lapses. */
  names: Promise<Set<string>>
  /** Epoch ms this scan may be retried after; 0 while it is in flight or has succeeded. */
  retryAfter: number
}

const scansByStore = new WeakMap<object, Map<string, BackfillScan>>()

function withScanDeadline(scan: Promise<Set<string>>): Promise<Set<string>> {
  return new Promise<Set<string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`retirement backfill scan exceeded ${RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS}ms`)
      )
    }, RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    timer.unref?.()
    void scan.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Memoizes the one-time retirement discovery scan per store and cwd namespace.
 *
 *  A success is kept for the process lifetime — a name never un-spends, so rescanning could only
 *  lose entries. A failure is not: the original cache held the scan Promise forever and its
 *  `readdir` had no deadline, so one stalled listing wedged this create and every later
 *  generated-name create for the namespace until Orca restarted. */
export function runRetirementBackfillScan(
  store: object,
  scanKey: string,
  scan: () => Promise<Set<string>>
): Promise<Set<string>> {
  let storeScans = scansByStore.get(store)
  if (!storeScans) {
    storeScans = new Map()
    scansByStore.set(store, storeScans)
  }
  const cached = storeScans.get(scanKey)
  if (cached && (cached.retryAfter === 0 || Date.now() < cached.retryAfter)) {
    return cached.names
  }
  const entry: BackfillScan = { names: Promise.resolve(new Set()), retryAfter: 0 }
  entry.names = withScanDeadline(scan()).catch((error: unknown) => {
    entry.retryAfter = Date.now() + RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS
    throw error
  })
  storeScans.set(scanKey, entry)
  return entry.names
}
