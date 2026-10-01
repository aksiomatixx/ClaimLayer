'use strict';

/**
 * Money helpers — integer cents at every new boundary (audit ledger,
 * action requests, authority limits). Existing services still compute in
 * floating dollars; they convert here when crossing into the new
 * subsystems. See the gap inventory: "Floating-point money".
 */

/**
 * Dollars (number or numeric string) → integer cents, rounded half away
 * from zero. toPrecision(15) removes binary representation error first, so
 * 1.005 → 101 (not 100) and 0.1 + 0.2 → 30.
 */
function toCents(amount) {
  if (amount == null || amount === '') return null;
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) throw new Error(`toCents: not a finite amount: ${amount}`);
  const scaled = Number((n * 100).toPrecision(15));
  const cents = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return cents === 0 ? 0 : cents; // never -0
}

/** Integer cents → dollars (for legacy dollar-denominated callers only). */
function fromCents(cents) {
  if (cents == null) return null;
  assertCents(cents, 'fromCents');
  return cents / 100;
}

/** Throws unless value is a safe, non-negative integer number of cents. */
function assertCents(value, field = 'amount') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer number of cents`);
  }
  return value;
}

/** '$1,234.56' for messages and reasons. */
function formatCents(cents) {
  if (cents == null) return 'n/a';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

module.exports = { toCents, fromCents, assertCents, formatCents };
