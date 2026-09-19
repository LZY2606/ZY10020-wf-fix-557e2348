import { format } from 'pretty-format';
import type { Cache, CacheEntry } from './common';
import type { CacheEvent, CreateReporter } from './reporter';

export function prettyPrint(value: any) {
  return format(value, {
    min: true,
    plugins: [
      {
        test(val) {
          return typeof val === 'string';
        },
        serialize(val, config, indentation, depth, refs) {
          return refs[0] &&
            typeof refs[0] === 'object' &&
            Object.keys(refs[refs.length - 1] as any).includes(val)
            ? val
            : `'${val}'`;
        },
      },
    ],
  });
}

export function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export function report(calls: [event: CacheEvent<any>][]) {
  const totalCalls = String(calls.length + 1).length;
  return calls
    .map(([{ name, ...payload }], i) => {
      const data = JSON.stringify(payload);
      const title = `${String(i + 1).padStart(totalCalls, ' ')}. ${name}`;
      if (!payload || data === '{}') {
        return title;
      }
      return `${title}\n${String('').padStart(
        totalCalls + 2,
        ' ',
      )}${prettyPrint(payload)}`;
    })
    .join('\n');
}
/**
 * Deterministic clock. Install fake timers that drive Date.now() so no real
 * time ever passes. Use `setTime` to move the clock and `drain` to flush
 * zero-delay timers (e.g. internal stale-refresh scheduling) and microtasks.
 */
export interface ControlledClock {
  now: number;
  setTime: (time: number) => void;
  advance: (ms: number) => void;
  /**
   * Flush pending zero-delay timers without advancing time and repeatedly run
   * microtasks until nothing new is scheduled (or `rounds` is exceeded).
   */
  drain: (rounds?: number) => Promise<void>;
  /** Same as `drain` but resolves early once `done` returns true. */
  drainUntil: (done: () => boolean, rounds?: number) => Promise<void>;
}

export function installControlledClock(start = 0): ControlledClock {
  jest.useFakeTimers();
  const clock = {
    now: start,
    setTime(time: number) {
      jest.setSystemTime(time);
      this.now = time;
    },
    advance(ms: number) {
      this.now += ms;
      jest.advanceTimersByTime(ms);
    },
    async drain(rounds = 50) {
      for (let round = 0; round < rounds; round++) {
        jest.advanceTimersByTime(0);
        for (let microtask = 0; microtask < 20; microtask++) {
          await Promise.resolve();
        }
      }
    },
    async drainUntil(done: () => boolean, rounds = 50) {
      for (let round = 0; round < rounds; round++) {
        if (done()) {
          return;
        }
        jest.advanceTimersByTime(0);
        for (let microtask = 0; microtask < 20; microtask++) {
          await Promise.resolve();
        }
      }
      throw new Error('drainUntil exceeded max rounds without condition');
    },
  };

  jest.setSystemTime(start);
  clock.now = Date.now();

  return clock;
}

/**
 * A manually controllable promise. Loader implementations return its promise
 * and the test decides when to resolve or reject. No setTimeout involved.
 */
export interface Gate<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  readonly settled: boolean;
}

export function createGate<T = string>(): Gate<T> {
  const gate: Partial<Gate<T>> = { settled: false };
  gate.promise = new Promise<T>((resolve, reject) => {
    gate.resolve = (value) => {
      (gate as { settled: boolean }).settled = true;
      resolve(value);
    };
    gate.reject = (reason) => {
      (gate as { settled: boolean }).settled = true;
      reject(reason);
    };
  });
  return gate as Gate<T>;
}

/**
 * Run microtasks only, never firing fake timers. Use this to let async
 * continuations settle while keeping scheduled zero-delay timers pending.
 */
export function flushMicrotasks(rounds = 20) {
  let chain = Promise.resolve();
  for (let round = 0; round < rounds; round++) {
    chain = chain.then(() => Promise.resolve());
  }
  return chain;
}

/**
 * In-memory cache adapter with spied methods so tests can assert the exact
 * number of reads / writes / deletes and inspect written TTL metadata.
 */
export interface InstrumentedCache<Value = unknown> {
  store: Map<string, CacheEntry<Value>>;
  cache: Cache<Value>;
  get: jest.SpiedFunction<Cache<Value>['get']>;
  set: jest.SpiedFunction<Cache<Value>['set']>;
  delete: jest.SpiedFunction<Cache<Value>['delete']>;
}

export function createInstrumentedCache<Value = unknown>(
  store = new Map<string, CacheEntry<Value>>(),
): InstrumentedCache<Value> {
  const cache: Cache<Value> = {
    get: (key) => store.get(key) as CacheEntry<Value> | undefined,
    set: (key, entry) => {
      store.set(key, entry);
    },
    delete: (key) => {
      store.delete(key);
    },
  };
  return {
    store,
    cache,
    get: jest.spyOn(cache, 'get'),
    set: jest.spyOn(cache, 'set'),
    delete: jest.spyOn(cache, 'delete'),
  };
}

export interface EventRecorder<Value = unknown> {
  reporter: CreateReporter<Value>;
  events: CacheEvent<Value>[];
  names: () => Array<CacheEvent<Value>['name']>;
  namesOf: (name: CacheEvent<Value>['name']) => Array<CacheEvent<Value>>;
  clear: () => void;
}

/** Reporter factory that records every event (shared log across calls). */
export function createEventRecorder<Value = unknown>(): EventRecorder<Value> {
  const events: CacheEvent<Value>[] = [];
  return {
    events,
    reporter: () => (event) => {
      events.push(event);
    },
    names: () => events.map((event) => event.name),
    namesOf: (name) => events.filter((event) => event.name === name),
    clear: () => {
      events.length = 0;
    },
  };
}

/** Deterministic seeded PRNG (mulberry32) so randomized scheduling is repeatable. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle driven by a provided random function. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/** Stable diagnostic string including the seed, used in failure messages. */
export function seedDiagnostic(seed: number, info: Record<string, unknown>) {
  return `seed=${seed} ${JSON.stringify(info)}`;
}

/**
 * Wrap an expectation so every matcher failure is prefixed with a diagnostic
 * message (used to print the active seed when randomized scheduling fails).
 */
export function expectWith<Value>(diagnostic: string, actual: Value) {
  return new Proxy(expect(actual), {
    get(target, property, receiver) {
      const matcher = Reflect.get(target, property, receiver);
      return (...args: unknown[]) => {
        try {
          return Reflect.apply(matcher, target, args);
        } catch (error) {
          throw new Error(`${diagnostic}\n${String(error)}`);
        }
      };
    },
  }) as ReturnType<typeof expect<Value>>;
}
