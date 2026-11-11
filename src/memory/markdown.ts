/** The Markdown form of durable memory: one file per memory under the state directory, readable and diffable without a database. */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_KINDS, type MemoryRecord } from './model.ts'
import type { MemoryStore } from './store.ts'

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** A filename that keeps the id readable; ids are generated from `[A-Za-z0-9_]`, so the mapping is one-to-one. */
const fileOf = (id: string): string => `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`

/** Serializes one record as Markdown: JSON-encoded front matter so any title, tag or body survives a round trip. */
export function renderMemory(record: MemoryRecord): string {
  const fields: [string, unknown][] = [['id', record.id], ['title', record.title], ['at', record.at], ['kind', record.kind],
    ...record.thread ? [['thread', record.thread] as [string, unknown]] : [],
    ...record.ticketId ? [['ticketId', record.ticketId] as [string, unknown]] : [],
    ['tags', record.tags], ['next', record.next], ...record.source ? [['source', record.source] as [string, unknown]] : []]
  const front = fields.map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join('\n')
  return `---\n${front}\n---\n${record.text}\n`
}

/** Parses one Markdown file back into a record; a file without usable front matter yields undefined. */
export function parseMemory(text: string): MemoryRecord | undefined {
  const match = FRONT_MATTER.exec(text)
  if (!match) return undefined
  const fields = new Map<string, unknown>()
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line)
    if (!field) continue
    const raw = field[2]!.trim()
    try { fields.set(field[1]!, JSON.parse(raw)) } catch { fields.set(field[1]!, raw) }
  }
  const id = fields.get('id'), title = fields.get('title'), at = fields.get('at')
  if (typeof id !== 'string' || typeof title !== 'string' || typeof at !== 'string') return undefined
  const strings = (name: string): string[] => {
    const value = fields.get(name)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }
  const string = (name: string): string | undefined => typeof fields.get(name) === 'string' ? fields.get(name) as string : undefined
  const kind = string('kind')
  return { id, title, at, text: text.slice(match[0].length).replace(/\r?\n$/, ''),
    kind: MEMORY_KINDS.includes(kind as MemoryRecord['kind']) ? kind as MemoryRecord['kind'] : 'note',
    tags: strings('tags'), next: strings('next'), ...string('thread') ? { thread: string('thread') } : {},
    ...string('ticketId') ? { ticketId: string('ticketId') } : {}, ...string('source') ? { source: string('source') } : {} }
}

/**
 * Memories in one directory, one `<id>.md` each. A write is a temporary file renamed over the target, so a crash leaves
 * either the old memory or the new one, never half of one; a malformed file is skipped rather than failing a recall.
 */
export class MarkdownMemory implements MemoryStore {
  constructor(readonly directory: string) {}

  save(record: MemoryRecord): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, fileOf(record.id))
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      writeFileSync(temporary, renderMemory(record), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, file)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }

  get(id: string): MemoryRecord | undefined {
    const file = join(this.directory, fileOf(id))
    if (!existsSync(file)) return undefined
    try { return parseMemory(readFileSync(file, 'utf8')) } catch { return undefined }
  }

  all(): MemoryRecord[] {
    if (!existsSync(this.directory)) return []
    const records: MemoryRecord[] = []
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      try {
        const record = parseMemory(readFileSync(join(this.directory, entry.name), 'utf8'))
        if (record) records.push(record)
      } catch { /* A file this store did not write, or one being replaced, is skipped. */ }
    }
    return records
  }
}
