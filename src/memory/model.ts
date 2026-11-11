/**
 * Durable memory of the deployment: what earlier work established, kept outside any Session so it survives a restart
 * and a changed model. A memory names the resources it came from and the memories it continues, so a reader expands
 * along the chain one hop at a time instead of loading everything (docs upstream 3.3, Chain of Recall).
 */
export interface MemoryRecord {
  /** Stable id, `mem_` prefixed; the resource `memory/<id>` serves it. */
  id: string
  /** One line a card shows; the body stays behind the resource until read. */
  title: string
  /** The memory itself, Markdown. */
  text: string
  /** ISO timestamp the memory was written. */
  at: string
  kind: MemoryKind
  /** Free-form labels a search can match, such as a component or a decision area. */
  tags: string[]
  /** The resources this memory continues or depends on, as `memory/<id>`, `ticket/<id>`, `thread/<key>`, `decision/<id>` or `trigger/<id>`. */
  next: string[]
  /** The resource the memory was learned from, when there is one. */
  source?: string
  /** The thread the memory belongs to, when it belongs to one. */
  thread?: string
  /** The ticket the memory came out of, when it came out of one. */
  ticketId?: string
  /** The memories this one replaced, when it was written by merging them; their bodies are no longer stored. */
  supersedes?: string[]
}

export const MEMORY_KINDS = ['note', 'decision', 'fact', 'lesson'] as const
export type MemoryKind = typeof MEMORY_KINDS[number]

/** The resource path of one memory. */
export const memoryResource = (id: string): string => `memory/${id}`

/**
 * A resource a memory may continue: another memory or a work object the resource router already serves.
 * Thread and trigger keys are source-defined and carry separators (`github:42`, `feishu:oc_team:om_1`), so they may
 * contain a colon; they may not contain a slash, which the resource grammar uses to name a part.
 */
export const MEMORY_REF = /^(?:memory\/[A-Za-z0-9._-]+|(?:ticket|decision)\/[A-Za-z0-9._-]+|(?:thread|trigger)\/[^/\s]+)$/

/** The relation a next hop is shown under, so a card names the hop instead of repeating its path. */
export function memoryRelation(ref: string): string {
  const kind = ref.slice(0, ref.indexOf('/'))
  return kind === 'memory' ? 'continues' : kind
}

/** A short, URL-safe id; the caller may pass its own for a stable reference. */
export function memoryId(seed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`): string {
  let hash = 0x811c9dc5
  for (const character of seed) hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193) >>> 0
  return `mem_${hash.toString(16).padStart(8, '0')}${seed.length.toString(16).padStart(2, '0')}`
}

/** The fields a caller supplies; the store fills `id` and `at` when they are absent. */
export type MemoryDraft = Pick<MemoryRecord, 'title' | 'text'> & Partial<Omit<MemoryRecord, 'title' | 'text'>>

/** Normalizes a draft into a record: tags and next hops trimmed and deduplicated, timestamps ISO, ids filled in. */
export function memoryRecord(draft: MemoryDraft, at = new Date().toISOString(), id = memoryId()): MemoryRecord {
  const clean = (values: readonly string[] | undefined): string[] => [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))]
  return { id: draft.id?.trim() || id, title: draft.title.trim(), text: draft.text, at: draft.at ?? at, kind: draft.kind ?? 'note',
    tags: clean(draft.tags), next: clean(draft.next), ...clean(draft.supersedes).length ? { supersedes: clean(draft.supersedes) } : {},
    ...draft.source ? { source: draft.source } : {},
    ...draft.thread ? { thread: draft.thread } : {}, ...draft.ticketId ? { ticketId: draft.ticketId } : {} }
}
