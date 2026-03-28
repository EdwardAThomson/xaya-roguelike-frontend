/**
 * Mersenne Twister (MT19937) — identical to C++ std::mt19937.
 *
 * This implementation produces the exact same sequence as the C++ standard
 * library mt19937 for any given seed.  This is critical for deterministic
 * dungeon generation matching the backend.
 *
 * Reference: https://en.wikipedia.org/wiki/Mersenne_Twister
 */
export class MT19937 {
  private mt: Uint32Array;
  private index: number;

  constructor(seed: number) {
    this.mt = new Uint32Array(624);
    this.index = 624;
    this.mt[0] = seed >>> 0;

    for (let i = 1; i < 624; i++) {
      // mt[i] = 1812433253 * (mt[i-1] ^ (mt[i-1] >> 30)) + i
      const prev = this.mt[i - 1];
      const xor = prev ^ (prev >>> 30);
      // Multiply using 32-bit arithmetic.
      this.mt[i] = (Math.imul(1812433253, xor) + i) >>> 0;
    }
  }

  /** Generate next 32-bit unsigned integer. */
  next(): number {
    if (this.index >= 624) {
      this.twist();
    }

    let y = this.mt[this.index++];
    y ^= (y >>> 11);
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= (y >>> 18);
    return y >>> 0;
  }

  /** Returns a random integer in [0, n). */
  nextInt(n: number): number {
    if (n <= 1) return 0;
    // Simple modulo — slight bias for large n but fine for our use case
    // (room sizes, positions, etc. are all small numbers).
    return this.next() % n;
  }

  /** Returns a random integer in [min, max] inclusive. */
  nextRange(min: number, max: number): number {
    return min + this.nextInt(max - min + 1);
  }

  private twist(): void {
    for (let i = 0; i < 624; i++) {
      const upper = this.mt[i] & 0x80000000;
      const lower = this.mt[(i + 1) % 624] & 0x7fffffff;
      const y = upper | lower;
      this.mt[i] = this.mt[(i + 397) % 624] ^ (y >>> 1);
      if (y & 1) {
        this.mt[i] ^= 0x9908b0df;
      }
      this.mt[i] >>>= 0;
    }
    this.index = 0;
  }
}
