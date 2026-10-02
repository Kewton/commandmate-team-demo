/**
 * Constrain a value to the inclusive range [min, max].
 *
 * @param {number} value - The value to clamp.
 * @param {number} min - Lower bound (inclusive).
 * @param {number} max - Upper bound (inclusive).
 * @returns {number} `value` limited to the [min, max] range.
 * @throws {RangeError} If `min` is greater than `max`.
 */
export function clamp(value, min, max) {
  if (min > max) {
    throw new RangeError(`clamp: min (${min}) must not be greater than max (${max})`);
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
