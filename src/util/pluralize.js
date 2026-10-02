/**
 * Pluralize a word based on a count.
 *
 * Returns `word` unchanged when `count` is exactly 1; otherwise appends "s".
 *
 * @param {string} word
 * @param {number} count
 * @returns {string}
 */
export function pluralize(word, count) {
  return count === 1 ? String(word) : `${word}s`;
}

export default pluralize;
