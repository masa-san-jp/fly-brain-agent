// Set semantics for non-negative integer indices, without allocating iterator
// objects during the simulation's sync path. Deletions leave tombstones until
// the next insertion needs room; live entries retain native Set order.
export class OrderedIndexSet {
  constructor(capacity) {
    this.present = new Uint8Array(capacity);
    this.order = new Int32Array(capacity);
    this.order.fill(-1);
    this.position = new Int32Array(capacity);
    this.position.fill(-1);
    this.size = 0;
    this.tail = 0;
  }
  has(i) { return this.present[i] !== 0; }
  add(i) {
    if (this.present[i]) return this;
    if (this.tail >= this.order.length) this.compact();
    this.present[i] = 1;
    this.position[i] = this.tail;
    this.order[this.tail++] = i;
    this.size++;
    return this;
  }
  delete(i) {
    if (!this.present[i]) return false;
    this.present[i] = 0;
    this.size--;
    this.order[this.position[i]] = -1;
    this.position[i] = -1;
    return true;
  }
  compact() {
    let n = 0;
    for (let k = 0; k < this.tail; k++) { const i = this.order[k]; if (i >= 0 && this.present[i]) { this.position[i] = n; this.order[n++] = i; } }
    this.order.fill(-1, n);
    this.tail = n;
  }
  copyTo(out) {
    let n = 0;
    for (let k = 0; k < this.tail; k++) { const i = this.order[k]; if (i >= 0 && this.present[i]) out[n++] = i; }
    return n;
  }
  forEach(fn) {
    for (let k = 0; k < this.tail; k++) { const i = this.order[k]; if (i >= 0 && this.present[i]) fn(i); }
  }
  *[Symbol.iterator]() {
    for (let k = 0; k < this.tail; k++) { const i = this.order[k]; if (i >= 0 && this.present[i]) yield i; }
  }
}
