/**
 * Count how many items fall under each key returned by `keyFn`.
 *
 * @param {unknown[]} items - The items to count.
 * @param {(item: unknown, index: number) => unknown} keyFn - Maps an item to its grouping key.
 * @returns {Record<string, number>} Counts keyed by the string form of each key.
 */
export function countBy(items, keyFn) {
  const counts = {};
  for (let index = 0; index < items.length; index += 1) {
    const key = keyFn(items[index], index);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
