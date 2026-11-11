import type { Store } from '../store.ts'
import { memoryCard, textPage } from '../cards.ts'
import { memoryRelation, type Memory, type MemoryKind, type MemoryRecord } from '../../memory/index.ts'
import { linksOf } from '../recall.ts'

/**
 * The part of the runtime a memory view needs: the two forms behind `Memory`, and the work objects a memory can point at.
 * `resources.ts` and the panel routes both build their answers from here, so a hop resolves the same way in either.
 */
export interface MemoryHost {
  store: Pick<Store, 'threads' | 'tickets' | 'decisions' | 'triggers'>
  memory: Pick<Memory, 'get' | 'list' | 'search'>
}

/** A memory's next hop, kept only while its target still exists, so recall never links to an entry that has gone. */
export function memoryTarget(host: MemoryHost, ref: string): string | undefined {
  const [kind, ...rest] = ref.split('/'), id = rest.join('/')
  const found = kind === 'memory' ? host.memory.get(id) : kind === 'thread' ? host.store.threads.get(id)
    : kind === 'ticket' ? host.store.tickets.get(id) : kind === 'decision' ? host.store.decisions.get(id)
      : kind === 'trigger' ? host.store.triggers.get(id) : undefined
  return found && ref
}

/**
 * The chain's next hops: the edition the memory came from, then every memory or work object it continues to. A hop whose
 * target has been forgotten is dropped rather than handed to a reader that would then fail on it.
 */
export function memoryLinks(host: MemoryHost, record: MemoryRecord) {
  return linksOf([
    ['source', record.source ? memoryTarget(host, record.source) : undefined],
    ...record.next.map(ref => [memoryRelation(ref), memoryTarget(host, ref)] as const),
  ])
}

/** Memories newest first; `q` matches words in title, text, tags, thread or ticket. */
export function memoryList(host: MemoryHost, query: string, offset: number, limit: number) {
  const found = query.trim() ? host.memory.search(query.trim(), 200) : host.memory.list(0, Number.MAX_SAFE_INTEGER)
  const items = found.slice(offset, offset + limit).map(memoryCard)
  return { items, next_offset: offset + items.length < found.length ? offset + items.length : null }
}

/**
 * One memory in full: the card without its own read path (this is that path), the ids it supersedes, the body as text
 * plus its next hops. `undefined` when the id is unknown, so a route can answer 404 rather than 500.
 */
export function memoryDetail(host: MemoryHost, id: string) {
  const record = host.memory.get(id)
  if (!record) return undefined
  const { read: _read, ...card } = memoryCard(record)
  return {
    ...card, ...memoryLinks(host, record),
    supersedes: record.supersedes ?? [],
    ...textPage(`memory/${record.id}`, record.text, 0, record.text.length),
  }
}

export type MemoryListView = ReturnType<typeof memoryList>
export type MemoryDetailView = NonNullable<ReturnType<typeof memoryDetail>>
/** The panel's merge form: the ids to fold, and the fields it overrides instead of taking the union. */
export interface MemoryMergeRequest {
  ids: string[]
  title?: string
  text?: string
  kind?: MemoryKind
  tags?: string[]
  next?: string[]
}
