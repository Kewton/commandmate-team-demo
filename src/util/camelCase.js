/**
 * Convert a string into camelCase.
 *
 * Words separated by spaces, hyphens or underscores are joined, with the first
 * word lowercased and each following word capitalized.
 *
 * @param {string} input
 * @returns {string}
 */
export function camelCase(input) {
  return String(input)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

export default camelCase;
