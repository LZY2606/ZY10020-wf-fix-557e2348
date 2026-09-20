import z from 'zod-legacy';
import {
  cachified,
  createBatch,
  createCacheEntry,
  CacheMetadata,
} from './index';
import { softPurge } from './softPurge';
import {
  ControlledPromise,
  createRecordingCache,
  createRecordingReporter,
  createSeededRandom,
  flushMicrotasks,
  nextMacrotask,
  seededShuffle,
} from './testHelpers';

jest.mock('./index', () => {
  if (process.version.startsWith('v20')) {
    return jest.requireActual('./index');
  } else {
    return require('../dist/index.cjs');
  }
});

let currentTime = 0;

/** Background refreshes hand their promise to waitUntil, we collect them here. */
function collectBackgroundTasks() {
  const backgroundTasks: Promise<unknown>[] = [];
  return {
    backgroundTasks,
    waitUntil: (promise: Promise<unknown>) => {
      backgroundTasks.push(promise);
    },
  };
}

/**
 * Classify reporter streams into the hit/miss/stale/error buckets the
 * public docs describe. refreshValue* events belong to the stale call.
 */
function classifyEvent(name: string) {
  if (
    name === 'getCachedValueSuccess' ||
    name === 'getFreshValueCacheFallback' ||
    name === 'getFreshValueSuccess'
  ) {
    return 'hit' as const;
  }
  if (name === 'getCachedValueEmpty') {
    return 'miss' as const;
  }
  if (
    name === 'getCachedValueOutdated' ||
    name === 'refreshValueStart' ||
    name === 'refreshValueSuccess'
  ) {
    return 'stale' as const;
  }
  if (
    name === 'getFreshValueError' ||
    name === 'refreshValueError' ||
    name === 'checkCachedValueError' ||
    name === 'checkCachedValueErrorObj' ||
    name === 'checkFreshValueError' ||
    name === 'checkFreshValueErrorObj' ||
    name === 'getCachedValueError'
  ) {
    return 'error' as const;
  }
  return null;
}

function classification(names: string[]) {
  return names
    .map(classifyEvent)
    .filter(
      (n): n is NonNullable<ReturnType<typeof classifyEvent>> => n !== null,
    );
}

describe('deterministic cache boundary behavior', () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  beforeAll(() => {
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterAll(() => {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  });

  beforeEach(() => {
    currentTime = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    unhandledRejections.length = 0;
  });

  afterEach(async () => {
    // flush queued microtasks including the 0ms stale-refresh chain
    await flushMicrotasks();
    expect(unhandledRejections).toEqual([]);
  });

  describe('fresh and stale windows', () => {
    it('returns a fresh hit without calling the loader or writing', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();
      cache.store.set(
        'k',
        createCacheEntry('cached', { createdTime: 0, ttl: 10, swr: 50 }),
      );
      const loader = jest.fn(() => 'fresh');

      currentTime = 5;
      const value = await cachified(
        {
          cache,
          key: 'k',
          ttl: 10,
          swr: 50,
          getFreshValue: loader,
        },
        reporter,
      );

      expect(value).toBe('cached');
      expect(loader).not.toHaveBeenCalled();
      expect(cache.getCalls).toEqual(['k']);
      expect(cache.setCalls).toEqual([]);
      expect(cache.deleteCalls).toEqual([]);
      expect(reporter.eventNames()).toEqual([
        'init',
        'getCachedValueStart',
        'getCachedValueRead',
        'getCachedValueSuccess',
        'done',
      ]);
      expect(classification(reporter.eventNames())).toEqual(['hit']);
    });

    it.each([1, 42, 20260920, 777])(
      'stale hit triggers exactly one background refresh for concurrent callers (seed %i)',
      async (seed) => {
        const cache = createRecordingCache<string>();
        const reporter = createRecordingReporter<string>();
        const { backgroundTasks, waitUntil } = collectBackgroundTasks();
        cache.store.set(
          'k',
          createCacheEntry('v0', { createdTime: 0, ttl: 10, swr: 50 }),
        );
        const loader = jest.fn(() => 'v1');
        const run = () =>
          cachified(
            {
              cache,
              key: 'k',
              ttl: 10,
              swr: 50,
              getFreshValue: loader,
              waitUntil,
            },
            reporter,
          );

        currentTime = 15; // inside stale window
        const order = seededShuffle([0, 1, 2], createSeededRandom(seed));
        const pending = new Array(3).fill(0).map(() => null as unknown);
        for (const index of order) {
          pending[index] = run();
          await flushMicrotasks(1);
        }

        const values = await Promise.all(pending as Promise<string>[]);
        expect(values).toEqual(['v0', 'v0', 'v0']);
        expect(loader).not.toHaveBeenCalled();

        // the stale refresh sleeps 0ms before starting
        await nextMacrotask();
        await Promise.all(backgroundTasks);

        expect(loader).toHaveBeenCalledTimes(1);
        expect((loader.mock.calls[0] as unknown[])[0]).toMatchObject({
          background: true,
          metadata: expect.objectContaining({ ttl: 10, swr: 50 }),
        });
        expect(cache.setCalls).toEqual(['k']);
        const written = cache.store.get('k')!;
        expect(written.value).toBe('v1');
        expect(written.metadata).toEqual(
          expect.objectContaining({
            ttl: 10,
            swr: 50,
            createdTime: 15,
          } satisfies Partial<CacheMetadata>),
        );
        expect(
          reporter.eventNames().filter((n: string) => n === 'done'),
        ).toHaveLength(3);
        expect(
          reporter
            .eventNames()
            .filter((n: string) => n === 'refreshValueStart'),
        ).toHaveLength(1);
        expect(classification(reporter.eventNames())).toEqual([
          'hit',
          'hit',
          'hit',
          'stale',
          'stale',
          'stale',
          'stale',
        ]);
      },
    );

    it('a second stale hit while refreshing is coalesced onto the in-flight refresh', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();
      const { backgroundTasks, waitUntil } = collectBackgroundTasks();
      cache.store.set(
        'k',
        createCacheEntry('v0', { createdTime: 0, ttl: 10, swr: 50 }),
      );
      const refresh = new ControlledPromise<string>();
      const loader = jest.fn(() => refresh.promise);
      const options = {
        cache,
        key: 'k',
        ttl: 10,
        swr: 50,
        getFreshValue: loader,
        waitUntil,
      };

      currentTime = 15;
      expect(await cachified(options, reporter)).toBe('v0');
      await nextMacrotask();
      await flushMicrotasks();
      expect(loader).toHaveBeenCalledTimes(1);

      // refresh still pending: second stale caller reuses it
      const second = cachified(options, reporter);
      await flushMicrotasks();
      expect(await second).toBe('v0');
      expect(loader).toHaveBeenCalledTimes(1);

      refresh.resolve('v1');
      await Promise.all(backgroundTasks);
      expect(cache.store.get('k')?.value).toBe('v1');
      expect(cache.setCalls).toEqual(['k']);
    });
  });

  describe('fully expired entries', () => {
    it.each([1, 42, 20260920, 777])(
      'concurrent requests on an expired entry are merged onto one loader (seed %i)',
      async (seed) => {
        const cache = createRecordingCache<string>();
        const reporter = createRecordingReporter<string>();
        cache.store.set(
          'k',
          createCacheEntry('old', { createdTime: 0, ttl: 10, swr: 5 }),
        );
        const loader = new ControlledPromise<string>();
        const loaderFn = jest.fn(() => loader.promise);
        const run = () =>
          cachified(
            {
              cache,
              key: 'k',
              ttl: 10,
              swr: 5,
              getFreshValue: loaderFn,
            },
            reporter,
          );

        currentTime = 100; // beyond ttl + swr
        const order = seededShuffle([0, 1, 2, 3], createSeededRandom(seed));
        const pending = new Array(4).fill(0).map(() => null as unknown);
        for (const index of order) {
          pending[index] = run();
          await flushMicrotasks(1);
        }
        await flushMicrotasks();

        expect(cache.getCalls).toEqual(['k', 'k', 'k', 'k']);
        expect(loaderFn).toHaveBeenCalledTimes(1);
        expect(
          reporter
            .eventNames()
            .filter((n: string) => n === 'getFreshValueHookPending'),
        ).toHaveLength(3);

        loader.resolve('new');
        await expect(
          Promise.all(pending as Promise<string>[]),
        ).resolves.toEqual(['new', 'new', 'new', 'new']);

        expect(cache.setCalls).toEqual(['k']);
        expect(cache.store.get('k')).toEqual(
          expect.objectContaining({
            value: 'new',
            metadata: expect.objectContaining({
              ttl: 10,
              swr: 5,
              createdTime: 100,
            }),
          }),
        );
        expect(classification(reporter.eventNames())).toEqual([
          'stale',
          'stale',
          'stale',
          'stale',
          'hit',
        ]);
      },
    );

    it('keeps serving the stale value when the background loader rejects', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();
      const { backgroundTasks, waitUntil } = collectBackgroundTasks();
      cache.store.set(
        'k',
        createCacheEntry('stale-value', { createdTime: 0, ttl: 10, swr: 50 }),
      );
      const failure = new Error('boom');
      const loader = jest.fn(async () => {
        throw failure;
      });
      const options = {
        cache,
        key: 'k',
        ttl: 10,
        swr: 50,
        getFreshValue: loader,
        waitUntil,
      };

      currentTime = 15;
      const value = await cachified(options, reporter);
      expect(value).toBe('stale-value');

      await nextMacrotask();
      await Promise.all(backgroundTasks);

      // stale entry is preserved
      expect(cache.store.get('k')?.value).toBe('stale-value');
      expect(cache.deleteCalls).toEqual([]);
      expect(cache.setCalls).toEqual([]);
      expect(loader).toHaveBeenCalledTimes(1);
      const names = reporter.eventNames();
      expect(names).toContain('refreshValueError');
      expect(names).not.toContain('refreshValueSuccess');
      expect(classification(names)).toEqual(['hit', 'stale', 'error']);
    });

    it('rejects every coalesced caller when a full-miss loader rejects', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();
      const failure = new Error('down');
      const loader = new ControlledPromise<string>();
      const loaderFn = jest.fn(() => loader.promise);
      const run = () =>
        cachified(
          {
            cache,
            key: 'k',
            ttl: 10,
            getFreshValue: loaderFn,
          },
          reporter,
        );

      const first = run();
      await flushMicrotasks();
      const rest = [run(), run()];
      await flushMicrotasks();

      expect(loaderFn).toHaveBeenCalledTimes(1);
      loader.reject(failure);

      await expect(first).rejects.toBe(failure);
      await expect(rest[0]).rejects.toBe(failure);
      await expect(rest[1]).rejects.toBe(failure);
      expect(cache.setCalls).toEqual([]);
      expect(
        reporter.eventNames().filter((n: string) => n === 'getFreshValueError'),
      ).toHaveLength(1);
      expect(classification(reporter.eventNames())).toEqual([
        'miss',
        'miss',
        'miss',
        'error',
      ]);
    });
  });

  describe('schema validation', () => {
    it('deletes and reloads when a schema rejects the cached value', async () => {
      const cache = createRecordingCache();
      const reporter = createRecordingReporter<{ name: string }>();
      cache.store.set(
        'user',
        createCacheEntry({ name: 123 }, { createdTime: 0, ttl: 10 }),
      );
      const loader = jest.fn((): unknown => ({ name: 'fixed' }));

      const value = await cachified(
        {
          cache,
          key: 'user',
          ttl: 10,
          checkValue: z.object({ name: z.string() }),
          getFreshValue: loader,
        },
        reporter,
      );

      expect(value).toEqual({ name: 'fixed' });
      expect(loader).toHaveBeenCalledTimes(1);
      expect(cache.deleteCalls).toEqual(['user']);
      expect(cache.setCalls).toEqual(['user']);
      const written = cache.store.get('user')!;
      expect(written.value).toEqual({ name: 'fixed' });
      expect(written.metadata).toEqual(
        expect.objectContaining({ ttl: 10, swr: 0, createdTime: 0 }),
      );
      const names = reporter.eventNames();
      expect(names).toContain('checkCachedValueError');
      expect(names).toContain('writeFreshValueSuccess');
      expect(classification(names)).toEqual(['error', 'error', 'hit']);
    });

    it('does not write a fresh value that the schema rejects', async () => {
      const cache = createRecordingCache();
      const reporter = createRecordingReporter<{ name: string }>();
      const loader = jest.fn((): unknown => ({ name: 42 }));

      await expect(
        cachified(
          {
            cache,
            key: 'user',
            ttl: 10,
            checkValue: z.object({ name: z.string() }),
            getFreshValue: loader,
          },
          reporter,
        ),
      ).rejects.toThrow('check failed for fresh value of user');

      expect(cache.setCalls).toEqual([]);
      expect(cache.store.size).toBe(0);
      const names = reporter.eventNames();
      expect(names).toContain('checkFreshValueError');
      expect(names).not.toContain('writeFreshValueSuccess');
      expect(classification(names)).toEqual(['miss', 'hit', 'error', 'error']);
    });
  });

  describe('softPurge', () => {
    it('makes a fresh entry stale immediately using ttl as the stale window', async () => {
      const cache = createRecordingCache<string>();
      cache.store.set(
        'k',
        createCacheEntry('v0', { createdTime: 0, ttl: 10, swr: 5 }),
      );

      currentTime = 3;
      await softPurge({ cache, key: 'k' });

      expect(cache.setCalls).toEqual(['k']);
      expect(cache.store.get('k')?.metadata).toEqual(
        expect.objectContaining({
          ttl: 0,
          swr: 15,
          createdTime: 0,
        }),
      );

      // still at time 3: entry now reads stale and triggers a refresh
      const reporter = createRecordingReporter<string>();
      const { backgroundTasks, waitUntil } = collectBackgroundTasks();
      const loader = jest.fn(() => 'v1');
      const value = await cachified(
        { cache, key: 'k', ttl: 10, swr: 5, getFreshValue: loader, waitUntil },
        reporter,
      );
      expect(value).toBe('v0');
      await nextMacrotask();
      await Promise.all(backgroundTasks);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(cache.store.get('k')?.value).toBe('v1');
    });

    it('keeps the forced-refresh value when softPurge races an in-flight refresh', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();
      const { backgroundTasks, waitUntil } = collectBackgroundTasks();
      cache.store.set(
        'k',
        createCacheEntry('v0', { createdTime: 0, ttl: 10, swr: 50 }),
      );
      const forced = new ControlledPromise<string>();
      const loader = jest.fn(() => forced.promise);
      const options = {
        cache,
        key: 'k',
        ttl: 10,
        swr: 50,
        getFreshValue: loader,
        waitUntil,
      };

      currentTime = 5;
      const forcedCall = cachified({ ...options, forceFresh: true }, reporter);
      await flushMicrotasks();
      expect(loader).toHaveBeenCalledTimes(1);

      // entry is still fresh when softPurge runs, forcing ttl to 0
      await softPurge({ cache, key: 'k' });
      expect(cache.store.get('k')?.value).toBe('v0');
      expect(cache.store.get('k')?.metadata.ttl).toBe(0);

      // stale caller before the forced refresh settles starts a background refresh
      const staleCall = cachified(options, reporter);
      await flushMicrotasks();
      await nextMacrotask();
      await flushMicrotasks();
      // the scheduled background refresh hooks onto the in-flight forced
      // refresh rather than calling the loader a second time
      expect(loader).toHaveBeenCalledTimes(1);
      expect(backgroundTasks).toHaveLength(1);

      expect(await staleCall).toBe('v0');
      forced.resolve('forced');
      expect(await forcedCall).toBe('forced');
      await Promise.all(backgroundTasks);

      // the in-flight refresh's value wins; softPurge's stale copy never
      // gets re-written on top of it
      expect(cache.store.get('k')?.value).toBe('forced');
      const success = reporter.events.find(
        (event: { name: string }) => event.name === 'refreshValueSuccess',
      );
      expect(success).toEqual({ name: 'refreshValueSuccess', value: 'forced' });
    });

    it('does nothing when the entry is already fully expired', async () => {
      const cache = createRecordingCache<string>();
      cache.store.set(
        'k',
        createCacheEntry('v0', { createdTime: 0, ttl: 1, swr: 1 }),
      );
      jest.spyOn(cache, 'set');

      currentTime = 100;
      await softPurge({ cache, key: 'k' });

      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.store.get('k')?.value).toBe('v0');
    });
  });

  describe('batch', () => {
    it('resolves successful keys and rejects failed keys of one batch', async () => {
      const cache = createRecordingCache<string>();
      const failure = new Error('partial');
      // A rejection member gets a no-op handler attached synchronously so
      // the test process never sees an unhandled rejection.
      const rejected = Promise.reject(failure);
      rejected.catch(() => {});
      const loader = jest.fn((indexes: number[]): any =>
        indexes.map((index: number) =>
          index === 2 ? rejected : Promise.resolve(`v-${index}`),
        ),
      );
      const batch = createBatch<string, number>(loader);

      const results = [1, 2, 3].map((index) =>
        cachified(
          {
            cache,
            key: `k-${index}`,
            ttl: 5,
            getFreshValue: batch.add(index),
          },
          createRecordingReporter(),
        ),
      );

      const settled = await Promise.allSettled(results);
      expect(settled.map((r) => r.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
      ]);
      expect((settled[0] as PromiseFulfilledResult<string>).value).toBe('v-1');
      expect((settled[2] as PromiseFulfilledResult<string>).value).toBe('v-3');
      await expect(results[1]).rejects.toBe(failure);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(loader).toHaveBeenCalledWith(
        [1, 2, 3],
        [expect.any(Object), expect.any(Object), expect.any(Object)],
      );
      expect(cache.store.get('k-1')?.value).toBe('v-1');
      expect(cache.store.get('k-2')).toBeUndefined();
      expect(cache.store.get('k-3')?.value).toBe('v-3');
      expect(cache.setCalls.sort()).toEqual(['k-1', 'k-3']);
    });

    it('calls the loader once per cache-missing key of a submitted manual batch', async () => {
      const cache = createRecordingCache<string>();
      cache.store.set('k-2', createCacheEntry('cached-2', { ttl: null }));
      const loader = jest.fn((indexes: number[]) =>
        indexes.map((index) => `v-${index}`),
      );
      const batch = createBatch<string, number>(loader, false);

      const pending = [1, 2, 3].map((index) =>
        cachified({
          cache,
          key: `k-${index}`,
          ttl: 5,
          getFreshValue: batch.add(index),
        }),
      );
      await flushMicrotasks();
      expect(loader).not.toHaveBeenCalled();

      await batch.submit();
      await expect(Promise.all(pending)).resolves.toEqual([
        'v-1',
        'cached-2',
        'v-3',
      ]);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(loader.mock.calls[0][0]).toEqual([1, 3]);
      expect(cache.setCalls.sort()).toEqual(['k-1', 'k-3']);
    });
  });

  describe('reporter hit/miss/stale/error ordering', () => {
    const baseOptions = {
      ttl: 10,
      swr: 50,
    };

    it('emits only the hit sequence on a fresh read', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();
      cache.store.set(
        'k',
        createCacheEntry('v0', { createdTime: 0, ttl: 10, swr: 50 }),
      );

      currentTime = 5;
      await cachified(
        { ...baseOptions, cache, key: 'k', getFreshValue: () => 'x' },
        reporter,
      );

      expect(reporter.eventNames()).toEqual([
        'init',
        'getCachedValueStart',
        'getCachedValueRead',
        'getCachedValueSuccess',
        'done',
      ]);
      expect(classification(reporter.eventNames())).toEqual(['hit']);
    });

    it('emits miss then write events in order for an empty cache', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();

      await cachified(
        { ...baseOptions, cache, key: 'k', getFreshValue: () => 'v0' },
        reporter,
      );

      expect(reporter.eventNames()).toEqual([
        'init',
        'getCachedValueStart',
        'getCachedValueRead',
        'getCachedValueEmpty',
        'getFreshValueStart',
        'getFreshValueSuccess',
        'writeFreshValueSuccess',
        'done',
      ]);
      expect(classification(reporter.eventNames())).toEqual(['miss', 'hit']);
      expect(cache.setCalls).toEqual(['k']);
      expect(cache.store.get('k')?.metadata).toEqual(
        expect.objectContaining({ ttl: 10, swr: 50 }),
      );
    });

    it('orders stale hit events before background refresh success', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();
      const { backgroundTasks, waitUntil } = collectBackgroundTasks();
      cache.store.set(
        'k',
        createCacheEntry('v0', { createdTime: 0, ttl: 10, swr: 50 }),
      );
      const loader = jest.fn(() => 'v1');

      currentTime = 15;
      expect(
        await cachified(
          {
            ...baseOptions,
            cache,
            key: 'k',
            getFreshValue: loader,
            waitUntil,
          },
          reporter,
        ),
      ).toBe('v0');

      // foreground sequence ends with done...
      const doneIndex = reporter.eventNames().indexOf('done');
      expect(reporter.eventNames().slice(0, doneIndex + 1)).toEqual([
        'init',
        'getCachedValueStart',
        'getCachedValueRead',
        'getCachedValueSuccess',
        'done',
      ]);

      await nextMacrotask();
      await Promise.all(backgroundTasks);

      // ...and the background refresh is reported afterwards in order
      expect(reporter.eventNames().slice(doneIndex + 1)).toEqual([
        'refreshValueStart',
        'refreshValueSuccess',
      ]);
      expect(classification(reporter.eventNames())).toEqual([
        'hit',
        'stale',
        'stale',
      ]);
    });

    it('reports the stale hit and the background error without failing the caller', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();
      const { backgroundTasks, waitUntil } = collectBackgroundTasks();
      cache.store.set(
        'k',
        createCacheEntry('v0', { createdTime: 0, ttl: 10, swr: 50 }),
      );
      const loader = jest.fn(() => {
        throw new Error('nope');
      });

      currentTime = 15;
      expect(
        await cachified(
          {
            ...baseOptions,
            cache,
            key: 'k',
            getFreshValue: loader,
            waitUntil,
          },
          reporter,
        ),
      ).toBe('v0');

      await nextMacrotask();
      await Promise.all(backgroundTasks);

      const names = reporter.eventNames();
      expect(names).toContain('refreshValueError');
      expect(names).not.toContain('refreshValueSuccess');
      expect(classification(names)).toEqual(['hit', 'stale', 'error']);
    });

    it('separates miss and error events when the loader rejects on empty cache', async () => {
      const cache = createRecordingCache<string>();
      const reporter = createRecordingReporter<string>();
      const failure = new Error('fatal');

      await expect(
        cachified(
          {
            ...baseOptions,
            cache,
            key: 'k',
            getFreshValue: () => {
              throw failure;
            },
          },
          reporter,
        ),
      ).rejects.toBe(failure);

      expect(reporter.eventNames()).toEqual([
        'init',
        'getCachedValueStart',
        'getCachedValueRead',
        'getCachedValueEmpty',
        'getFreshValueStart',
        'getFreshValueError',
      ]);
      expect(classification(reporter.eventNames())).toEqual(['miss', 'error']);
      expect(cache.setCalls).toEqual([]);
    });
  });
});
