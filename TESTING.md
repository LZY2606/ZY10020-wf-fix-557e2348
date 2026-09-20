# Testing

## Acceptance command

```sh
npm ci            # one-time prep (installs deps and builds dist via prepare)
npm test -- --runInBand
```

Run both from the repository root. No external services, environment
variables, or network access are required; exit code is zero on success.

On Node versions other than v20, the specs run against the bundled
`dist/index.cjs` (see the `jest.mock('./index', …)` block in the specs), so
after changing anything under `src/` rebuild it with:

```sh
npm run build:esm && npm run build:cjs
```

## Deterministic boundary tests

`src/deterministic.spec.ts` covers decisions and event ordering when calls
pile up around the expiry boundary. It uses no real sleeps:

- `Date.now()` is mocked to a manually advanced `currentTime`.
- Loaders return `ControlledPromise` values (see `src/testHelpers.ts`) whose
  resolve/reject is driven by the test.
- The only timer involved is the library's own 0 ms stale-refresh timer,
  released deterministically with `nextMacrotask()` (a `setTimeout(…, 0)`
  yield, not a duration-based sleep).
- Concurrent callers are scheduled with `seededShuffle(items,
createSeededRandom(seed))`; the coalescing tests run under several seeds
  via `it.each`, and the seed is part of the test name, so a failure prints
  e.g. `(seed 42)`.
- `afterEach` asserts the global `unhandledRejection` collector is empty, so
  background-refresh rejections or rejected batch members cannot leak.

Named tests (24):

- `returns a fresh hit without calling the loader or writing`
- `stale hit triggers exactly one background refresh for concurrent callers (seed <seed>)` ×4 seeds
- `a second stale hit while refreshing is coalesced onto the in-flight refresh`
- `concurrent requests on an expired entry are merged onto one loader (seed <seed>)` ×4 seeds
- `keeps serving the stale value when the background loader rejects`
- `rejects every coalesced caller when a full-miss loader rejects`
- `deletes and reloads when a schema rejects the cached value`
- `does not write a fresh value that the schema rejects`
- `makes a fresh entry stale immediately using ttl as the stale window`
- `keeps the forced-refresh value when softPurge races an in-flight refresh`
- `does nothing when the entry is already fully expired`
- `resolves successful keys and rejects failed keys of one batch`
- `calls the loader once per cache-missing key of a submitted manual batch`
- `emits only the hit sequence on a fresh read`
- `emits miss then write events in order for an empty cache`
- `orders stale hit events before background refresh success`
- `reports the stale hit and the background error without failing the caller`
- `separates miss and error events when the loader rejects on empty cache`

Each test asserts return values **and** adapter invocation counts
(`getCalls`/`setCalls`/`deleteCalls` on `createRecordingCache`), written TTL
metadata, and reporter event ordering (buckets hit/miss/stale/error).

## Mutation check (stale-refresh coalescing)

Mutation applied temporarily in `src/getCachedValue.ts`: the stale-while-
revalidate branch was changed to invoke `getFreshValue` directly instead of
going through the nested `cachified(...)` call, which removes de-duplication
via the internal pending-values map. After rebuilding `dist`, the failing
test is:

- `fresh and stale windows › stale hit triggers exactly one background
refresh for concurrent callers (seed 1|42|20260920|777)`

Failure signal (identical for every seed — i.e. stable, not flaky):

```
expect(jest.fn()).toHaveBeenCalledTimes(expected)

Expected number of calls: 1
Received number of calls: 3

  at src/deterministic.spec.ts:186:24
  expect(loader).toHaveBeenCalledTimes(1);
```

`a second stale hit while refreshing is coalesced onto the in-flight refresh`
also fails under this mutation. Reverting the change and rebuilding restores
all 96 tests to green.
