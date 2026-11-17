/* Exact rational arithmetic.
 *
 * WRC scoring must be exact. A hanchan score is (points - goal) / 1,000 plus a
 * uma that may be split between two, three or four tied players, and the
 * rulebook's own worked examples only come out right if none of that is done in
 * floating point.
 *
 * JavaScript has no Decimal or Fraction, but it has BigInt, and a rational held
 * as a pair of BigInts is the same object as Python's Fraction. This file is
 * the whole of that: there is no dependency and nothing to install.
 *
 * ---------------------------------------------------------------------------
 * START HERE. A Rational is just a numerator and a denominator, both BigInt,
 * kept in lowest terms. add/sub/mul/div/neg/cmp do the obvious things exactly.
 *
 * The two that matter for scoring are at the bottom:
 *
 *   truncate(places)    keeps the given number of decimals and throws the rest
 *                       away, WITHOUT rounding. This is the WRC rule, and it
 *                       falls out for free because BigInt division truncates
 *                       toward zero. One line does it.
 *   roundHalfUp(places) the alternative, for clubs that round instead. Which
 *                       one is used is a tournament setting, not a constant.
 *
 * Nothing here knows about mahjong. The scoring lives in scoring.js.
 * ---------------------------------------------------------------------------
 *
 * This was checked against the original Python engine rather than against
 * anyone's reading of the rules: 48,000 hanchan scores over 12,000 tables,
 * 5,527 of which contained a tie, every value identical. The Python has since
 * been retired, so that harness is gone; docs/TECHNICAL.md records what it
 * covered under "How the port was verified".
 */
(function () {
'use strict';

function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

class Rational {
  /** Always stored reduced, with a positive denominator. */
  constructor(numerator, denominator = 1n) {
    let n = BigInt(numerator);
    let d = BigInt(denominator);
    if (d === 0n) throw new RangeError('rational with a zero denominator');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
    Object.freeze(this);
  }

  /** Accepts a Rational, a BigInt, a safe integer, or a decimal string. */
  static of(value) {
    if (value instanceof Rational) return value;
    if (typeof value === 'bigint') return new Rational(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError(`not a number: ${value}`);
      if (Number.isInteger(value)) return new Rational(BigInt(value));
      return Rational.parse(String(value));
    }
    if (typeof value === 'string') return Rational.parse(value);
    if (value === null || value === undefined) return ZERO;
    throw new TypeError(`cannot read ${typeof value} as a number`);
  }

  /** Parse "12", "-3.5", "7/2" exactly -- no float ever touches the value. */
  static parse(text) {
    const s = String(text).trim();
    if (s === '') return ZERO;
    const ratio = /^([+-]?\d+)\s*\/\s*(\d+)$/.exec(s);
    if (ratio) return new Rational(BigInt(ratio[1]), BigInt(ratio[2]));
    const dec = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
    if (!dec || (dec[2] === '' && (dec[3] === undefined || dec[3] === ''))) {
      throw new TypeError(`not a number: ${text}`);
    }
    const sign = dec[1] === '-' ? -1n : 1n;
    const whole = dec[2] === '' ? 0n : BigInt(dec[2]);
    const frac = dec[3] || '';
    const scale = 10n ** BigInt(frac.length);
    const fracValue = frac === '' ? 0n : BigInt(frac);
    return new Rational(sign * (whole * scale + fracValue), scale);
  }

  add(other) {
    const o = Rational.of(other);
    return new Rational(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(other) {
    const o = Rational.of(other);
    return new Rational(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(other) {
    const o = Rational.of(other);
    return new Rational(this.n * o.n, this.d * o.d);
  }

  div(other) {
    const o = Rational.of(other);
    if (o.n === 0n) throw new RangeError('division by zero');
    return new Rational(this.n * o.d, this.d * o.n);
  }

  neg() {
    return new Rational(-this.n, this.d);
  }

  /** -1, 0 or 1. */
  cmp(other) {
    const o = Rational.of(other);
    const left = this.n * o.d;
    const right = o.n * this.d;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  eq(other) { return this.cmp(other) === 0; }
  lt(other) { return this.cmp(other) < 0; }
  gt(other) { return this.cmp(other) > 0; }
  get isZero() { return this.n === 0n; }
  get sign() { return this.n === 0n ? 0 : this.n < 0n ? -1 : 1; }

  /** Exact only when the denominator divides evenly; used for display. */
  toNumber() {
    return Number(this.n) / Number(this.d);
  }

  /**
   * Cut to `places` decimals, discarding the rest.
   *
   * This is the WRC Optional Rules instruction verbatim: "keep only one decimal
   * without rounding". BigInt division truncates toward zero, which is exactly
   * that -- for -6.666 it gives -6.6, not -6.7.
   */
  truncate(places = 1) {
    const scale = 10n ** BigInt(places);
    const scaled = (this.n * scale) / this.d;
    return new Rational(scaled, scale);
  }

  /** Round half away from zero, for organisers who prefer it to truncation. */
  roundHalfUp(places = 1) {
    const scale = 10n ** BigInt(places);
    const doubled = this.n * scale * 2n;
    const twiceD = this.d * 2n;
    let q = doubled / twiceD;
    const rem = doubled - q * twiceD;
    const half = this.d;
    if (rem >= half) q += 1n;
    else if (rem <= -half) q -= 1n;
    return new Rational(q, scale);
  }

  /**
   * Fixed-point text, e.g. "-6.6". This is what lands in the CSVs, so it has to
   * be built from the integers rather than via a float.
   */
  toFixed(places = 1) {
    const t = this.truncate(places);
    const scale = 10n ** BigInt(places);
    const scaled = (t.n * scale) / t.d;
    const negative = scaled < 0n;
    const abs = negative ? -scaled : scaled;
    const whole = abs / scale;
    if (places === 0) return `${negative ? '-' : ''}${whole}`;
    const frac = (abs % scale).toString().padStart(places, '0');
    return `${negative ? '-' : ''}${whole}.${frac}`;
  }

  /** Shortest exact text: "15", "-6.6", or "7/3" when it does not terminate. */
  toString() {
    if (this.d === 1n) return this.n.toString();
    // A denominator of only 2s and 5s terminates in decimal.
    let d = this.d;
    let twos = 0;
    let fives = 0;
    while (d % 2n === 0n) { d /= 2n; twos++; }
    while (d % 5n === 0n) { d /= 5n; fives++; }
    if (d === 1n) return this.toFixed(Math.max(twos, fives));
    return `${this.n}/${this.d}`;
  }

  toJSON() {
    return this.toString();
  }
}

const ZERO = new Rational(0n);
const ONE = new Rational(1n);

/** Exact sum of a list, left to right. */
function sum(values) {
  let total = ZERO;
  for (const v of values) total = total.add(v);
  return total;
}

const R = (value, denominator) =>
  denominator === undefined ? Rational.of(value) : new Rational(value, denominator);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Rational, R, sum, ZERO, ONE };
}
if (typeof window !== 'undefined') {
  window.RT = window.RT || {};
  window.RT.rational = { Rational, R, sum, ZERO, ONE };
}
}());
