# Testing

## Run

```sh
npm ci
npm test -- --runInBand
```

Both commands run from the repository root, require no external services or
environment variables, and exit non-zero on failure. `npm ci` builds `dist`
(via the `prepare` script); the Jest suite executes against `dist/index.cjs`
on Node versions other than v20.

## Deterministic boundary tests

`src/deterministic.spec.ts` contains 15 named tests (one is a seeded
`it.each` over 4 fixed seeds) for expiry-boundary decisions and event order.

Controls live in `src/testHelpers.ts`:

- `installControlledClock` — fake timers driving `Date.now`; time only moves
  via `setTime` / `advance`, there is no real sleep.
- `flushMicrotasks` — runs async continuations without firing any timer.
- `ControlledClock.drain` — fires pending zero-delay timers and microtasks
  deterministically.
- `createGate` — manually resolved/rejected promises for loaders.
- `createInstrumentedCache` — in-memory adapter with spied `get`/`set`/`delete`.
- `createEventRecorder` — shared reporter collecting every cache event.
- `seededRandom` / `shuffle` / `expectWith` — seeded scheduling; failure
  messages print `seed=<n>` plus the observed state.

`afterEach` asserts there are no unhandled rejections and clears any
remaining fake timers.

## Mutation check: stale-refresh concurrent coalescing

Production location: `src/cachified.ts`, the pending-value hook block
(`if (pendingValues.has(key)) { ... if (!isExpired(metadata)) { ... } }`).

Mutation applied temporarily:

```diff
-  if (pendingValues.has(key)) {
+  /* MUTATION: stale-refresh concurrent coalescing temporarily removed */
+  if (false && pendingValues.has(key)) {
```

After rebuilding `dist` (`npm run build:esm && npm run build:cjs`), the test
that must fail is:

- **Test name:** `stale hit [seed 0: 1]: concurrent stale callers trigger
  exactly one background refresh` (all four seeded variants of this test
  fail).
- **Failure signal:**

```
● deterministic cachified decisions at expiry boundaries › stale hit [seed 0: 1]: concurrent stale callers trigger exactly one background refresh

  seed=1 {}
  Error: expect(received).toBe(expected) // Object.is equality

  Expected: 1
  Received: 3
```

Each of the three stale callers schedules its own background refresh and
invokes the gated loader, so the one-loader / one-write assertion fails with
`Received: 3`. The `seed=1` prefix is the deterministic scheduling seed.
The mutation was reverted and the full suite was confirmed green afterwards.
