/**
 * Add up every number in an array.
 *
 * @param {number[]} numbers - The values to total.
 * @returns {number} The sum of `numbers`, or 0 when the array is empty.
 */
export function sum(numbers) {
  let total = 0;
  for (const value of numbers) {
    total += value;
  }
  return total;
}
