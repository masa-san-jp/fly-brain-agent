// Ordered Map-like rates for sensory transduction. Values remain Float64 so
// the arithmetic and the value passed to the brain have the same JS precision
// as a native Map<number, number>.
export class RateMap {
  constructor(capacity) {
    this.values = new Float64Array(capacity);
    this.present = new Uint8Array(capacity);
    this.order = new Int32Array(capacity);
    this.size = 0;
  }
  clear() {
    for (let k = 0; k < this.size; k++) this.present[this.order[k]] = 0;
    this.size = 0;
  }
  has(i) { return this.present[i] !== 0; }
  get(i) { return this.present[i] ? this.values[i] : undefined; }
  setOne(i, hz) {
    if (this.present[i]) {
      if (hz > this.values[i]) this.values[i] = hz;
    } else if (hz > 0) {
      this.present[i] = 1;
      this.values[i] = hz;
      this.order[this.size++] = i;
    }
    return this;
  }
  set(ix, hz) { for (let k = 0; k < ix.length; k++) this.setOne(ix[k], hz); return this; }
  // Native Map.set overwrites an existing value. Used by the eye overlay,
  // whose historical path used Map.set rather than Senses.set's max rule.
  putOne(i, hz) {
    if (!this.present[i]) { this.present[i] = 1; this.order[this.size++] = i; }
    this.values[i] = hz;
    return this;
  }
  forEach(fn) { for (let k = 0; k < this.size; k++) { const i = this.order[k]; fn(this.values[i], i, this); } }
  *[Symbol.iterator]() { for (let k = 0; k < this.size; k++) { const i = this.order[k]; yield [i, this.values[i]]; } }
}
