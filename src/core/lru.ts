/**
 * Bounded LRU with frame pinning. Memory has to stay flat over an arbitrarily long exploration
 * session, so every cache in the project is bounded; entries touched this frame are protected from
 * eviction so the working set is never thrashed by its own size limit.
 */
export class Lru<V> {
  private readonly map = new Map<string, V>();
  private readonly pinned = new Map<string, number>();
  private frame = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.map.size;
  }

  beginFrame(): void {
    this.frame++;
  }

  pin(key: string): void {
    this.pinned.set(key, this.frame);
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    this.evict();
  }

  private evict(): void {
    while (this.map.size > this.capacity) {
      let victim: string | null = null;
      for (const key of this.map.keys()) {
        const pin = this.pinned.get(key);
        if (pin === undefined || pin < this.frame - 1) {
          victim = key;
          break;
        }
      }
      // Everything is pinned: the working set legitimately exceeds capacity this frame. Drop the
      // oldest anyway rather than growing without bound.
      if (victim === null) victim = this.map.keys().next().value ?? null;
      if (victim === null) return;
      this.map.delete(victim);
      this.pinned.delete(victim);
    }
  }
}
