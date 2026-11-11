/** The database form of durable memory: one SQLite table, in its own file under the state directory. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MemoryRecord } from './model.ts'
import type { MemoryStore } from './store.ts'

/**
 * Memories in a SQLite file beside the orchestrator database. The file is separate so the memory subsystem can fail
 * open: an unreadable or unmigratable memory database leaves the deployment running on the Markdown form.
 */
export class SqliteMemory implements MemoryStore {
  readonly db: DatabaseSync
  /**
   * Opens or creates the memory database at `path` and ensures the table.
   * @throws When the file cannot be opened or the table cannot be created; the caller falls back to Markdown.
   */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
        + 'CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);'
        + 'CREATE INDEX IF NOT EXISTS memory_at ON memory(at);')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  save(record: MemoryRecord): void {
    this.db.prepare('INSERT INTO memory (id, value, at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at')
      .run(record.id, JSON.stringify(record), record.at)
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare('SELECT value FROM memory WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as MemoryRecord : undefined
  }

  all(): MemoryRecord[] {
    return this.db.prepare('SELECT value FROM memory ORDER BY at DESC, rowid DESC').all()
      .map(row => JSON.parse(String(row.value)) as MemoryRecord)
  }

  close(): void { this.db.close() }
}
