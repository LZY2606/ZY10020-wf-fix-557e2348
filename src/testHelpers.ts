import { format } from 'pretty-format';
import { CacheEvent } from './reporter';
import { Cache, CacheEntry, Context } from './common';
import type { CreateReporter } from './reporter';

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

/**
 * Deterministic 32-bit PRNG (mulberry32).
 * Same seed always produces the same sequence, which lets us repeat
 * randomised scheduling of concurrent calls.
 */
export function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Fisher–Yates shuffle driven by the supplied random fn.
 * Returns a new array, the input is not mutated.
 */
export function seededShuffle<T>(items: readonly T[], random: () => number) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * A promise whose settlement is fully controlled by the test.
 * No timers are involved, so no unhandled rejection can leak once
 * `reject` is called while the promise is observed.
 */
export class ControlledPromise<T> {
  readonly promise: Promise<T>;
  readonly resolve!: (value: T | PromiseLike<T>) => void;
  readonly reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      (this as { resolve: typeof res }).resolve = res;
      (this as { reject: typeof rej }).reject = rej;
    });
  }
}

/**
 * Run queued microtasks without advancing real time or waiting on a timer.
 * Jest's fake timers keep promises/microtasks running normally, a handful
 * of turns is enough to flush the internal await chains.
 */
export async function flushMicrotasks(turns = 20) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

/**
 * Yield to the macrotask queue once without sleeping for any duration.
 * Used to release the 0ms stale-refresh timer deterministically.
 */
export function nextMacrotask() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export interface RecordingCache<Value = unknown> extends Cache<Value> {
  store: Map<string, CacheEntry<Value>>;
  getCalls: string[];
  setCalls: string[];
  deleteCalls: string[];
}

/**
 * Map-backed cache adapter that records every adapter invocation.
 * Contains no cachified internals: it only forwards to a Map.
 */
export function createRecordingCache<Value = unknown>(
  store: Map<string, CacheEntry<Value>> = new Map(),
): RecordingCache<Value> {
  return {
    store,
    getCalls: [],
    setCalls: [],
    deleteCalls: [],
    get(key) {
      this.getCalls.push(key);
      return store.get(key);
    },
    set(key, entry) {
      this.setCalls.push(key);
      store.set(key, entry);
    },
    delete(key) {
      this.deleteCalls.push(key);
      store.delete(key);
    },
  };
}

export type RecordingReporter<Value = any> = CreateReporter<Value> & {
  events: CacheEvent<Value>[];
  eventNames: () => string[];
};

/**
 * Reporter factory that records every event (including the synthetic
 * `init` marker) for order assertions.
 */
export function createRecordingReporter<
  Value = any,
>(): RecordingReporter<Value> {
  const events: CacheEvent<Value>[] = [];
  const reporter: any = (context: Omit<Context<Value>, 'report'>) => {
    events.push({
      name: 'init',
      key: context.key,
      metadata: context.metadata,
    } as unknown as CacheEvent<Value>);
    return (event: CacheEvent<Value>) => {
      events.push(event);
    };
  };
  reporter.events = events;
  reporter.eventNames = () => events.map((event) => event.name);
  return reporter;
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
