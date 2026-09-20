import { logKey } from './assertCacheEntry';
import { totalTtl } from './common';
import {
  createSeededRandom,
  seededShuffle,
  createRecordingCache,
  ControlledPromise,
} from './testHelpers';
import { createCacheEntry } from './common';

describe('totalTtl helper', () => {
  it('handles metadata without ttl gracefully', () => {
    expect(totalTtl({ createdTime: 0, swr: 5 })).toBe(5);
  });
});

describe('internal logKey helper', () => {
  it('falls back to empty string, when no key given', () => {
    expect(logKey()).toBe('');
  });
});

describe('test controls', () => {
  it('produces repeatable sequences from the same seed', () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const seqA = Array.from({ length: 8 }, a);
    const seqB = Array.from({ length: 8 }, b);
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(Array.from({ length: 8 }, createSeededRandom(7)));
  });

  it('shuffles deterministically from a seed', () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const random = createSeededRandom(1234);
    const first = seededShuffle(items, random);
    const second = seededShuffle(items, createSeededRandom(1234));
    expect(first).toEqual(second);
    expect(first).not.toEqual(items);
    expect([...first].sort((x, y) => x - y)).toEqual(items);
  });

  it('gives full control over a promise settlement', async () => {
    const pending = new ControlledPromise<string>();
    let settled = false;
    pending.promise.then((value) => {
      settled = true;
      expect(value).toBe('done');
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve('done');
    await pending.promise;
    expect(settled).toBe(true);
  });

  it('records adapter invocations', () => {
    const cache = createRecordingCache();
    expect(cache.get('a')).toBeUndefined();
    cache.set('a', createCacheEntry('v', { ttl: 1 }));
    expect((cache.get('a') as ReturnType<typeof createCacheEntry>).value).toBe(
      'v',
    );
    cache.delete('a');
    expect(cache.getCalls).toEqual(['a', 'a']);
    expect(cache.setCalls).toEqual(['a']);
    expect(cache.deleteCalls).toEqual(['a']);
    expect(cache.store.size).toBe(0);
  });
});
