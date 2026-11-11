/** Storage backends for durable memories and the façade that keeps the database and the Markdown files in step. */
import { memoryRecord, type MemoryRecord } from './model.ts'

/** One storage form: the SQLite table or the Markdown directory. Both implement the same operations. */
export interface MemoryStore {
  save(record: MemoryRecord): void
  get(id: string): MemoryRecord | undefined
  /** Every record, newest first. */
  all(): MemoryRecord[]
  /** Deletes one record; false when this form did not hold it. */
  remove(id: string): boolean
  /** Releases an open handle, when the form holds one. */
  close?(): void
}

export interface MemoryBackends {
  /** The database store, absent when its file cannot be opened or queried. */
  readonly database?: MemoryStore
  /** The Markdown directory store; always present. */
  readonly markdown: MemoryStore
  /** Why the database is absent, when it is. */
  readonly fallback?: string
}

/**
 * Durable memory over both forms at once. A save lands in every available store, so the database is the default and the
 * Markdown files are the human-readable copy; a read merges them by id with the database winning, so memories written
 * before the database existed (or while it was unavailable) stay recallable. When the database cannot be opened the
 * Markdown directory alone carries the memory and nothing fails.
 */
export class Memory {
  constructor(private readonly backends: MemoryBackends) {}

  /** Writes `record` to every available store; a store that fails is skipped and the others keep the memory. */
  save(record: MemoryRecord): { record: MemoryRecord; backends: ('database' | 'markdown')[] } {
    const written: ('database' | 'markdown')[] = []
    const failures: unknown[] = []
    for (const [name, store] of this.entries()) {
      try { store.save(record); written.push(name) } catch (error) { failures.push(error) }
    }
    if (!written.length && failures.length) throw failures[0]
    return { record, backends: written }
  }

  /** The record with `id`, from the database first and the Markdown copy otherwise. */
  get(id: string): MemoryRecord | undefined {
    for (const [, store] of this.entries()) {
      const found = store.get(id)
      if (found) return found
    }
    return undefined
  }

  /** Every record either store holds, newest first, one entry per id. */
  all(): MemoryRecord[] {
    const merged = new Map<string, MemoryRecord>()
    for (const [, store] of this.entries()) {
      for (const record of store.all()) if (!merged.has(record.id)) merged.set(record.id, record)
    }
    return [...merged.values()].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  }

  list(offset: number, limit: number): MemoryRecord[] {
    return this.all().slice(offset, offset + limit)
  }

  /** Forgets `id` in every store that holds it, so neither form can bring it back on the next read. */
  remove(id: string): { id: string; removed: boolean } {
    let removed = false
    for (const [, store] of this.entries()) {
      try { if (store.remove(id)) removed = true } catch { /* A store that cannot be written is the one that keeps it. */ }
    }
    return { id, removed }
  }

  /**
   * Replaces several memories with one: the bodies are joined under their titles, the tags and next hops are united, and
   * the sources are deleted from every store. The merged entry records their ids in `supersedes`, so a reader can still
   * tell where the text came from after the originals are gone.
   * @throws When fewer than two of `ids` exist.
   */
  merge(ids: readonly string[], draft: Partial<Pick<MemoryRecord, 'title' | 'text' | 'kind' | 'tags' | 'next'>> = {}):
  { record: MemoryRecord; backends: ('database' | 'markdown')[]; removed: string[] } {
    const records = [...new Set(ids)].flatMap(id => { const record = this.get(id); return record ? [record] : [] })
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    if (records.length < 2) throw new Error('Merging needs at least two existing memories')
    const merged = records.map(record => `## ${record.title}\n\n${record.text}`).join('\n\n')
    const body = draft.text?.trim() || merged
    const record = memoryRecord({
      title: draft.title?.trim() || records.map(item => item.title).join(' / ').slice(0, 200),
      text: body, kind: draft.kind ?? records[0]!.kind,
      tags: draft.tags ?? records.flatMap(item => item.tags),
      next: draft.next ?? records.flatMap(item => item.next).filter(ref => !records.some(item => `memory/${item.id}` === ref)),
      supersedes: records.map(item => item.id),
      ...records[0]!.source ? { source: records[0]!.source } : {}, ...records[0]!.thread ? { thread: records[0]!.thread } : {},
      ...records[0]!.ticketId ? { ticketId: records[0]!.ticketId } : {},
    })
    const saved = this.save(record)
    const removed = records.flatMap(item => this.remove(item.id).removed ? [item.id] : [])
    return { ...saved, removed }
  }

  /**
   * Records whose title, body, tags, thread or ticket contains every word of `query` (case-insensitive), newest first.
   * The words are matched, not ranked: this is a way back into the chain, not a search index.
   */
  search(query: string, limit = 10): MemoryRecord[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const haystack = (record: MemoryRecord) => [record.title, record.text, ...record.tags, record.thread ?? '', record.ticketId ?? '']
      .join('\n').toLowerCase()
    return this.all().filter(record => words.every(word => haystack(record).includes(word))).slice(0, limit)
  }

  /** Which forms are live, for status and diagnostics. */
  status(): { database: boolean; markdown: boolean; fallback?: string } {
    return { database: this.backends.database !== undefined, markdown: this.backends.markdown !== undefined,
      ...this.backends.fallback ? { fallback: this.backends.fallback } : {} }
  }

  /** Closes every store that holds a handle (the SQLite database); the Markdown directory needs none. */
  close(): void {
    for (const [, store] of this.entries()) store.close?.()
  }

  private entries(): [('database' | 'markdown'), MemoryStore][] {
    const entries: [('database' | 'markdown'), MemoryStore][] = []
    if (this.backends.database) entries.push(['database', this.backends.database])
    entries.push(['markdown', this.backends.markdown])
    return entries
  }
}
