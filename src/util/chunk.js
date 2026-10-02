/**
 * Split an array into consecutive sub-arrays of `size` elements.
 *
 * The final chunk holds the remainder and may be shorter than `size`.
 *
 * @param {unknown[]} items - The array to split.
 * @param {number} size - Number of elements per chunk (a positive integer).
 * @returns {unknown[][]} The chunks in order, or an empty array when `items` is empty.
 * @throws {RangeError} If `size` is not a positive integer.
 */
export function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk: size (${size}) must be a positive integer`);
  }
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
