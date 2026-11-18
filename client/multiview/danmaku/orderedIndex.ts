/** Indexed minimum heap: removed history never leaves lazy tombstones behind. */
export class OrderedIndex<T extends { key: string }> {
  private readonly items: T[] = [];
  private readonly positions = new Map<string, number>();
  constructor(private readonly compare: (a: T, b: T) => number) {}
  first(): T | undefined { return this.items[0]; }
  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    this.positions.set(this.items[a].key, a); this.positions.set(this.items[b].key, b);
  }
  private up(index: number): number {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.items[parent], this.items[index]) <= 0) break;
      this.swap(index, parent); index = parent;
    }
    return index;
  }
  private down(index: number): void {
    for (;;) {
      const left = index * 2 + 1, right = left + 1;
      let next = index;
      if (left < this.items.length && this.compare(this.items[left], this.items[next]) < 0) next = left;
      if (right < this.items.length && this.compare(this.items[right], this.items[next]) < 0) next = right;
      if (next === index) return;
      this.swap(index, next); index = next;
    }
  }
  add(value: T): void {
    this.remove(value.key);
    this.positions.set(value.key, this.items.length); this.items.push(value); this.up(this.items.length - 1);
  }
  remove(key: string): void {
    const index = this.positions.get(key);
    if (index === undefined) return;
    const last = this.items.pop()!; this.positions.delete(key);
    if (index === this.items.length) return;
    this.items[index] = last; this.positions.set(last.key, index);
    this.down(this.up(index));
  }
  clear(): void { this.items.length = 0; this.positions.clear(); }
}
