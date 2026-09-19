/*
 * Deterministic decision/event-order tests for cachified.
 *
 * Everything here runs on a fully controlled clock (jest fake timers driving
 * Date.now) with manually resolved loader promises. There is no real sleep
 * and the wall clock never advances on its own. Randomized scheduling uses
 * fixed seeds and failures print the seed plus the observed state.
 */
import {
  cachified,
  createBatch,
  getPendingValuesCache,
  createCacheEntry,
  softPurge,
} from './index';
import type { CachifiedOptions } from './common';
import type { StandardSchemaV1 } from './StandardSchemaV1';
import {
  ControlledClock,
  createEventRecorder,
  createGate,
  flushMicrotasks,
  createInstrumentedCache,
  expectWith,
  installControlledClock,
  seedDiagnostic,
  seededRandom,
  shuffle,
} from './testHelpers';

jest.mock('./index', () => {
  if (process.version.startsWith('v20')) {
    return jest.requireActual('./index');
  } else {
    console.log('⚠️ Running Tests against dist/index.cjs');
    return require('../dist/index.cjs');
  }
});

let clock: ControlledClock;
let unhandledRejections: unknown[];

function onUnhandledRejection(reason: unknown) {
  unhandledRejections.push(reason);
}

beforeEach(() => {
  unhandledRejections = [];
  process.on('unhandledRejection', onUnhandledRejection);
  clock = installControlledClock(0);
});

afterEach(async () => {
  await clock.drain();
  if (jest.getTimerCount() !== 0) {
    jest.clearAllTimers();
  }
  jest.useRealTimers();
  process.removeListener('unhandledRejection', onUnhandledRejection);
  if (unhandledRejections.length > 0) {
    throw new Error(
      `test left unhandled rejection(s): ${unhandledRejections
        .map((reason) => String(reason))
        .join(', ')}`,
    );
  }
});

/** Flush timers/microtasks a fixed number of rounds (no time advancement). */
async function settle(rounds = 10) {
  await clock.drain(rounds);
}

/** Observe a rejection so it can never surface as an unhandled rejection. */
async function observed<T>(promise: Promise<T>): Promise<T | unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

/** Let async continuations run while keeping all fake timers pending. */
async function microtasks(rounds = 20) {
  await flushMicrotasks(rounds);
}

function getPendingValuesCacheSize(
  cache: CachifiedOptions<string>['cache'],
  key: string,
) {
  return getPendingValuesCache(cache).has(key);
}

describe('deterministic cachified decisions at expiry boundaries', () => {
  it('fresh hit: returns cached value and never calls the loader', async () => {
    const {
      store,
      cache,
      get,
      set,
      delete: remove,
    } = createInstrumentedCache<string>();
    store.set('k', createCacheEntry('cached', { ttl: 10, swr: 10 }));
    const loader = jest.fn(() => 'fresh');
    const recorder = createEventRecorder<string>();

    const options = (): CachifiedOptions<string> => ({
      cache,
      key: 'k',
      ttl: 10,
      swr: 10,
      getFreshValue: loader,
    });

    const value = await cachified(options(), recorder.reporter);

    clock.setTime(9);
    const valueAtEdge = await cachified(options(), recorder.reporter);

    expect(value).toBe('cached');
    expect(valueAtEdge).toBe('cached');
    expect(loader).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(recorder.names()).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
    ]);
  });

  it.each([1, 42, 7331, 20260919])(
    'stale hit [seed %#: %s]: concurrent stale callers trigger exactly one background refresh',
    async (seed) => {
      const { store, cache, set } = createInstrumentedCache<string>();
      store.set('k', createCacheEntry('v0', { ttl: 10, swr: 50 }));
      const loaderGates = [createGate<string>(), createGate<string>()];
      const loader = jest.fn((): Promise<string> => {
        const gate = loaderGates[loader.mock.calls.length - 1];
        return gate.promise;
      });
      const refreshTasks: Promise<unknown>[] = [];
      const recorders = [0, 1, 2, 3].map(() => createEventRecorder<string>());
      const baseOptions = (): CachifiedOptions<string> => ({
        cache,
        key: 'k',
        ttl: 10,
        swr: 50,
        getFreshValue: loader,
        waitUntil(task) {
          refreshTasks.push(task);
        },
      });

      clock.setTime(15);
      const order = shuffle([0, 1, 2], seededRandom(seed));
      const pending = order.map((index) =>
        cachified(baseOptions(), recorders[index].reporter),
      );
      await microtasks();

      expectWith(
        seedDiagnostic(seed, { order }),
        await Promise.all(pending),
      ).toEqual(['v0', 'v0', 'v0']);
      expectWith(seedDiagnostic(seed, {}), jest.getTimerCount()).toBe(1);

      // a fourth caller arrives while the refresh loader itself is in flight
      const fourth = cachified(baseOptions(), recorders[3].reporter);
      await settle();
      expectWith(
        seedDiagnostic(seed, { calls: loader.mock.calls.length }),
        await fourth,
      ).toBe('v0');
      expectWith(
        seedDiagnostic(seed, { calls: loader.mock.calls.length }),
        loader.mock.calls.length,
      ).toBe(1);

      loaderGates[0].resolve('v1');
      await settle();
      await Promise.all(refreshTasks);

      const starts = recorders.reduce(
        (count, recorder) =>
          count + recorder.namesOf('refreshValueStart').length,
        0,
      );
      const successes = recorders.reduce(
        (count, recorder) =>
          count + recorder.namesOf('refreshValueSuccess').length,
        0,
      );
      expectWith(seedDiagnostic(seed, { starts }), starts).toBe(1);
      expectWith(seedDiagnostic(seed, { successes }), successes).toBe(4);
      expect(set).toHaveBeenCalledTimes(1);
      expect(set.mock.calls[0][1].metadata).toEqual(
        expect.objectContaining({ createdTime: 15, ttl: 10, swr: 50 }),
      );
      expect(store.get('k')?.value).toBe('v1');
      expect(loaderGates[1].settled).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('fully expired: concurrent callers coalesce onto one loader and one write', async () => {
    const {
      store,
      cache,
      get,
      set,
      delete: remove,
    } = createInstrumentedCache<string>();
    store.set('k', createCacheEntry('v0', { ttl: 10, swr: 10 }));
    const gate = createGate<string>();
    const loader = jest.fn(() => gate.promise);
    const recorder = createEventRecorder<string>();
    const options = (): CachifiedOptions<string> => ({
      cache,
      key: 'k',
      ttl: 10,
      swr: 10,
      getFreshValue: loader,
    });

    clock.setTime(25);
    const first = cachified(options(), recorder.reporter);
    const second = cachified(options(), recorder.reporter);
    const third = cachified(options(), recorder.reporter);
    await microtasks();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();

    gate.resolve('v1');
    const values = await Promise.all([first, second, third]);

    expect(values).toEqual(['v1', 'v1', 'v1']);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(3);
    expect(set.mock.calls[0][1]).toEqual(
      createCacheEntry('v1', { ttl: 10, swr: 10, createdTime: 25 }),
    );
    expect(getPendingValuesCacheSize(cache, 'k')).toBe(false);
    expect(recorder.namesOf('getFreshValueStart')).toHaveLength(1);
    expect(recorder.namesOf('getFreshValueHookPending')).toHaveLength(2);
    expect(recorder.namesOf('done')).toHaveLength(3);
  });

  it('fully expired: rejected coalesced load rejects every caller and clears pending state', async () => {
    const {
      store,
      cache,
      set,
      delete: remove,
    } = createInstrumentedCache<string>();
    store.set('k', createCacheEntry('v0', { ttl: 5 }));
    const gate = createGate<string>();
    const loader = jest.fn(() => gate.promise);
    const options = (): CachifiedOptions<string> => ({
      cache,
      key: 'k',
      ttl: 5,
      getFreshValue: loader,
    });

    clock.setTime(50);
    const first = cachified(options());
    const second = cachified(options());
    await microtasks();
    expect(loader).toHaveBeenCalledTimes(1);

    gate.reject(new Error('boom'));
    const errors = await Promise.all([observed(first), observed(second)]);

    expect(errors).toEqual([new Error('boom'), new Error('boom')]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(getPendingValuesCacheSize(cache, 'k')).toBe(false);
    expect(store.get('k')?.value).toBe('v0');
  });

  it('stale refresh rejection keeps serving the old value and leaves cache untouched', async () => {
    const {
      store,
      cache,
      get,
      set,
      delete: remove,
    } = createInstrumentedCache<string>();
    store.set('k', createCacheEntry('v0', { ttl: 10, swr: 50 }));
    const gate = createGate<string>();
    const loader = jest.fn(() => gate.promise);
    const refreshTasks: Promise<unknown>[] = [];
    const recorder = createEventRecorder<string>();
    const options = (): CachifiedOptions<string> => ({
      cache,
      key: 'k',
      ttl: 10,
      swr: 50,
      getFreshValue: loader,
      waitUntil(task) {
        refreshTasks.push(task);
      },
    });

    clock.setTime(15);
    const value = await cachified(options(), recorder.reporter);
    expect(value).toBe('v0');
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);

    gate.reject(new Error('refresh down'));
    await settle();
    await Promise.all(refreshTasks);

    expect(store.get('k')?.value).toBe('v0');
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);

    // next stale call still gets the retained value and retries the refresh
    const gate2 = createGate<string>();
    loader.mockImplementationOnce(() => gate2.promise);
    const retryTasks: Promise<unknown>[] = [];
    const value2 = await cachified(
      { ...options(), waitUntil: (task) => retryTasks.push(task) },
      recorder.reporter,
    );
    expect(value2).toBe('v0');
    gate2.resolve('v1');
    await settle();
    await Promise.all(retryTasks);
    expect(store.get('k')?.value).toBe('v1');
    expect(recorder.namesOf('refreshValueError')).toHaveLength(1);
    expect(recorder.namesOf('refreshValueSuccess')).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('schema rejecting the cached value deletes it and reloads via loader', async () => {
    const {
      store,
      cache,
      get,
      set,
      delete: remove,
    } = createInstrumentedCache<number>();
    store.set('k', createCacheEntry(12345, { ttl: 100, swr: 100 }));
    const gate = createGate<number>();
    const loader = jest.fn(() => gate.promise);
    const validator: StandardSchemaV1<unknown, number> = {
      '~standard': {
        version: 1,
        vendor: 'deterministic-test',
        validate(value) {
          return typeof value === 'number' && value < 100
            ? { value }
            : { issues: [{ message: 'must be small' }] };
        },
      },
    };
    const recorder = createEventRecorder<number>();

    const pending = cachified(
      {
        cache,
        key: 'k',
        ttl: 100,
        swr: 100,
        checkValue: validator,
        getFreshValue: loader,
      },
      recorder.reporter,
    );
    await microtasks();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();

    gate.resolve(7);
    expect(await pending).toBe(7);

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][1]).toEqual(
      createCacheEntry(7, { ttl: 100, swr: 100, createdTime: 0 }),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(recorder.namesOf('checkCachedValueErrorObj')).toHaveLength(1);
    expect(recorder.namesOf('checkCachedValueError')).toHaveLength(1);
    expect(recorder.namesOf('getCachedValueSuccess')).toHaveLength(0);
    expect(recorder.namesOf('writeFreshValueSuccess')).toHaveLength(1);
  });

  it('cache adapter read error deletes the key and reloads through the loader', async () => {
    const {
      store,
      cache,
      get,
      set,
      delete: remove,
    } = createInstrumentedCache<string>();
    store.set('k', createCacheEntry('v0', { ttl: 10 }));
    const readError = new Error('adapter down');
    get.mockImplementationOnce(() => {
      throw readError;
    });
    const gate = createGate<string>();
    const loader = jest.fn(() => gate.promise);
    const recorder = createEventRecorder<string>();

    const pending = cachified(
      { cache, key: 'k', ttl: 10, getFreshValue: loader },
      recorder.reporter,
    );
    await microtasks();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);

    gate.resolve('v1');
    expect(await pending).toBe('v1');
    expect(set).toHaveBeenCalledTimes(1);
    expect(store.get('k')?.value).toBe('v1');
    expect(recorder.namesOf('getCachedValueError')).toEqual([
      expect.objectContaining({ error: readError }),
    ]);
  });

  it('soft purge during an in-flight refresh: stale callers share the refresh and final write wins', async () => {
    const { store, cache, get, set } = createInstrumentedCache<string>();
    store.set('k', createCacheEntry('v0', { ttl: 10, swr: 0, createdTime: 0 }));
    const gate = createGate<string>();
    const loader = jest.fn(() => gate.promise);
    const refreshTasks: Promise<unknown>[] = [];
    const recorders = [0, 1].map(() => createEventRecorder<string>());
    const options = (): CachifiedOptions<string> => ({
      cache,
      key: 'k',
      ttl: 10,
      getFreshValue: loader,
      waitUntil(task) {
        refreshTasks.push(task);
      },
    });

    // refresh is forced while the entry is still fresh and loader is pending
    const forced = cachified(
      { ...options(), forceFresh: true },
      recorders[0].reporter,
    );
    await microtasks();
    expect(loader).toHaveBeenCalledTimes(1);

    // purge marks the fresh entry stale (ttl 0 + remaining window)
    await softPurge({ cache, key: 'k', swr: 30 });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][1].metadata).toEqual(
      expect.objectContaining({ ttl: 0, swr: 30, createdTime: 0 }),
    );

    // stale reader must hook onto the already running refresh
    const staleReader = cachified(options(), recorders[1].reporter);
    await microtasks();
    expect(await staleReader).toBe('v0');
    expect(loader).toHaveBeenCalledTimes(1);

    gate.resolve('v1');
    expect(await forced).toBe('v1');
    await settle();
    await Promise.all(refreshTasks);

    expect(loader).toHaveBeenCalledTimes(1);
    const writes = set.mock.calls.map((call) => call[1]);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(
      createCacheEntry('v1', { ttl: 10, createdTime: 0 }),
    );
    expect(store.get('k')).toEqual(
      createCacheEntry('v1', { ttl: 10, createdTime: 0 }),
    );
    expect(get).toHaveBeenCalledTimes(2);
    // the stale reader returned its cached value and queued no own loader
    expect(recorders[1].namesOf('getCachedValueSuccess')).toHaveLength(1);
    expect(recorders[1].namesOf('getFreshValueStart')).toHaveLength(0);
    expect(recorders[1].namesOf('refreshValueStart')).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not write when the value arrives only after total ttl elapsed', async () => {
    const { store, cache, set } = createInstrumentedCache<string>();
    const gate = createGate<string>();
    const loader = jest.fn(() => gate.promise);
    const recorder = createEventRecorder<string>();

    const pending = cachified(
      { cache, key: 'k', ttl: 10, swr: 10, getFreshValue: loader },
      recorder.reporter,
    );
    await microtasks();

    // value arrives beyond ttl + swr: writing is suppressed
    clock.setTime(21);
    gate.resolve('late');
    expect(await pending).toBe('late');

    expect(set).not.toHaveBeenCalled();
    expect(store.has('k')).toBe(false);
    const writeEvent = recorder.namesOf('writeFreshValueSuccess');
    expect(writeEvent).toHaveLength(1);
    expect(writeEvent[0]).toEqual(expect.objectContaining({ written: false }));
  });

  it('batch: one rejecting key fails only that request and the key reloads on retry', async () => {
    const {
      store,
      cache,
      get,
      set,
      delete: remove,
    } = createInstrumentedCache<string>();
    const batchLoader = jest.fn((keys: string[]) => {
      const values: PromiseSettledResult<string>[] = keys.map((key) =>
        key === 'k-bad'
          ? { status: 'rejected', reason: new Error('partial failure') }
          : { status: 'fulfilled', value: `value:${key}` },
      );
      return values.map((entry) =>
        entry.status === 'fulfilled'
          ? entry.value
          : Promise.reject(entry.reason),
      ) as unknown as string[];
    });
    const recorder = createEventRecorder<string>();
    const batch = createBatch<string, string>(batchLoader);
    const promises = ['k-a', 'k-bad', 'k-c'].map((key) => {
      const getFreshValue = batch.add(key);
      return cachified({ cache, key, getFreshValue }, recorder.reporter);
    });
    const results = await Promise.allSettled(promises);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'value:k-a' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'value:k-c' });
    expect(
      results[1].status === 'rejected' ? results[1].reason : undefined,
    ).toEqual(new Error('partial failure'));

    expect(batchLoader).toHaveBeenCalledTimes(1);
    expect(batchLoader).toHaveBeenCalledWith(
      ['k-a', 'k-bad', 'k-c'],
      expect.any(Array),
    );
    expect(set).toHaveBeenCalledTimes(2);
    expect(store.get('k-a')?.value).toBe('value:k-a');
    expect(store.get('k-c')?.value).toBe('value:k-c');
    expect(store.has('k-bad')).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(recorder.namesOf('getFreshValueError')).toHaveLength(1);
    expect(recorder.namesOf('writeFreshValueSuccess')).toHaveLength(2);

    // retry the failed key only: fresh cache hits for the other two
    const retryBatch = createBatch<string, string>((keys) =>
      keys.map((key) => `retry:${key}`),
    );
    const retry = await Promise.all(
      ['k-a', 'k-bad', 'k-c'].map((key) =>
        cachified(
          { cache, key, getFreshValue: retryBatch.add(key) },
          recorder.reporter,
        ),
      ),
    );

    expect(retry).toEqual(['value:k-a', 'retry:k-bad', 'value:k-c']);
    expect(batchLoader).toHaveBeenCalledTimes(1);
    expect(store.get('k-bad')?.value).toBe('retry:k-bad');
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('reporter emits a deterministic hit / miss / stale / error event order', async () => {
    const { store, cache } = createInstrumentedCache<string>();
    const recorder = createEventRecorder<string>();
    const options = (
      getFreshValue: CachifiedOptions<string>['getFreshValue'],
    ): CachifiedOptions<string> => ({
      cache,
      key: 'k',
      ttl: 5,
      swr: 20,
      getFreshValue,
      waitUntil() {},
    });

    // 1. cold miss
    expect(
      await cachified(
        options(() => 'v0'),
        recorder.reporter,
      ),
    ).toBe('v0');
    expect(recorder.names()).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueEmpty',
      'getFreshValueStart',
      'getFreshValueSuccess',
      'writeFreshValueSuccess',
      'done',
    ]);
    recorder.clear();

    // 2. fresh hit
    expect(
      await cachified(
        options(() => 'x'),
        recorder.reporter,
      ),
    ).toBe('v0');
    expect(recorder.names()).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
    ]);
    recorder.clear();

    // 3. stale hit served immediately, background refresh reported afterwards
    clock.setTime(6);
    expect(
      await cachified(
        options(() => 'v1'),
        recorder.reporter,
      ),
    ).toBe('v0');
    await settle();
    const staleNames = recorder.names();
    expect(staleNames.slice(0, 4)).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueSuccess',
      'done',
    ]);
    expect(staleNames).toContain('refreshValueStart');
    expect(staleNames).toContain('refreshValueSuccess');
    expect(staleNames.indexOf('done')).toBe(3);
    recorder.clear();

    // 4. fully expired entry -> error path order (rejected loader)
    clock.setTime(100);
    const gate = createGate<string>();
    const pending = cachified(
      options(() => gate.promise),
      recorder.reporter,
    );
    gate.reject(new Error('dead'));
    await expect(pending).rejects.toThrow('dead');
    expect(recorder.names()).toEqual([
      'getCachedValueStart',
      'getCachedValueRead',
      'getCachedValueOutdated',
      'getFreshValueStart',
      'getFreshValueError',
    ]);
  });

  it('fresh value written with requested ttl metadata and boundary timing respected', async () => {
    const { store, cache, set } = createInstrumentedCache<string>();
    const loader = jest.fn(() => 'v0');

    const value = await cachified({
      cache,
      key: 'k',
      ttl: 30,
      swr: 15,
      getFreshValue: loader,
    });
    expect(value).toBe('v0');
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][1].metadata).toEqual({
      createdTime: 0,
      ttl: 30,
      swr: 15,
    });

    // at exactly validUntil the entry is still fresh (boundary inclusive)
    clock.setTime(30);
    expect(
      await cachified({
        cache,
        key: 'k',
        ttl: 30,
        swr: 15,
        getFreshValue: () => 'x',
      }),
    ).toBe('v0');
    expect(loader).toHaveBeenCalledTimes(1);

    // one ms later it is stale: gated background refresh is scheduled
    clock.setTime(31);
    const gate = createGate<string>();
    loader.mockImplementationOnce(() => gate.promise as unknown as string);
    const stale = cachified({
      cache,
      key: 'k',
      ttl: 30,
      swr: 15,
      getFreshValue: loader,
      waitUntil() {},
    });
    expect(await stale).toBe('v0');
    await settle();
    expect(loader).toHaveBeenCalledTimes(2);

    gate.resolve('v1');
    await settle();
    expect(store.get('k')?.value).toBe('v1');
    expect(store.get('k')?.metadata.createdTime).toBe(31);
  });
});
