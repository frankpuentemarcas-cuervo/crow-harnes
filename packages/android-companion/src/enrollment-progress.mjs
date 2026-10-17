/** Pair each entry independently, retaining only failures for a safe retry.
 * @template T, R
 * @param {T[]} items
 * @param {(item: T) => Promise<R>} pairOne
 * @returns {Promise<{paired: R[], pending: T[], failure: unknown, failures: {item: T, error: unknown}[]}>}
 */
export async function pairEnrollmentItems(items, pairOne) {
  const paired = []
  const failures = []
  for (const item of items) {
    try { paired.push(await pairOne(item)) }
    catch (error) { failures.push({ item, error }) }
  }
  return { paired, pending: failures.map(entry => entry.item), failure: failures[0]?.error, failures }
}
