/** Pure landing DAG helpers shared by join, layout, and dispatch. */

const LANDING_KEY = /^landing:(\d+)$/u

/**
 * Drop a landing `blocked-by` edge that only restates a numbered sibling.
 * Ticket 3 `Blocked by: 1, 2` next to Ticket 2 `Blocked by: 1` keeps 1→2
 * and 1→3 so the fan-out sits in one rank. Ticket 3 `Blocked by: 2` alone,
 * or a join `Blocked by: 2, 3` that does not also list 1, stays stacked.
 */
export function essentialBlockedBy<E extends { from: string; to: string; kind: string }>(
  edges: readonly E[],
): E[] {
  const landing = edges.filter(edge =>
    edge.kind === 'blocked-by'
    && LANDING_KEY.test(edge.from)
    && LANDING_KEY.test(edge.to),
  )
  if (landing.length === 0) return [...edges]
  const parents = new Map<string, Set<string>>()
  for (const edge of landing) {
    const set = parents.get(edge.from) ?? new Set()
    set.add(edge.to)
    parents.set(edge.from, set)
  }
  const of = (id: string): Set<string> => parents.get(id) ?? new Set()
  return edges.filter((edge) => {
    if (
      edge.kind !== 'blocked-by'
      || !LANDING_KEY.test(edge.from)
      || !LANDING_KEY.test(edge.to)
    ) return true
    const sibling = of(edge.to)
    if (sibling.size === 0) return true
    const own = of(edge.from)
    for (const parent of sibling) {
      if (!own.has(parent)) return true
    }
    return false
  })
}
