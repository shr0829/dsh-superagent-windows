/** Storage backends for durable memories and the façade that keeps the database and the Markdown files in step. */
import type { MemoryRecord } from './model.ts'

/** One storage form: the SQLite table or the Markdown directory. Both implement the same operations. */
export interface MemoryStore {
  save(record: MemoryRecord): void
  get(id: string): MemoryRecord | undefined
  /** Every record, newest first. */
  all(): MemoryRecord[]
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
