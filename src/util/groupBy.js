/**
 * Group the elements of an array by a key derived from each element.
 *
 * Elements are appended in input order, so each group preserves the order in
 * which its members appeared in `items`. The input array is not mutated.
 *
 * @param {unknown[]} items - The array to group.
 * @param {(item: unknown) => PropertyKey} keyFn - Returns the group key for an element.
 * @returns {Record<string, unknown[]>} A map from key to the elements with that key.
 */
export function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    if (Object.hasOwn(groups, key)) {
      groups[key].push(item);
    } else {
      groups[key] = [item];
    }
  }
  return groups;
}
