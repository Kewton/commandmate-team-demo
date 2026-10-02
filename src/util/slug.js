/**
 * Convert an arbitrary string into a URL-friendly slug.
 *
 * - lowercases the input
 * - collapses any run of non-alphanumeric characters (spaces, symbols) into a
 *   single hyphen
 * - strips leading and trailing hyphens
 *
 * @param {string} input
 * @returns {string}
 */
export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default slugify;
