/**
 * Chain of Recall: every projection names the resources of the objects it stands for, so a reader expands from what it already
 * has to a neighbour one hop at a time, and only the hops it asks for reach the prompt.
 */
export interface RecallLink { rel: string; read: string }
/** One expandable reference; `rel` says how the target relates to the object the projection stands for. A target that is not there adds nothing. */
export const link = (rel: string, read: string | undefined): readonly (readonly [string, string])[] => read ? [[rel, read]] : []
/** Collects links for a projection, omitting the ones without a target so no link names a resource that is not served. */
export function linksOf(pairs: readonly (readonly [string, string | undefined])[]): { links: RecallLink[] } {
  return { links: pairs.flatMap(([rel, read]) => read ? [{ rel, read }] : []) }
}
