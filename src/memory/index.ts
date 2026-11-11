/** Durable memory as the rest of the deployment uses it: the facade plus the two storage forms. */
import { join } from 'node:path'
import { MarkdownMemory } from './markdown.ts'
import { SqliteMemory } from './sqlite.ts'
import { Memory } from './store.ts'

/**
 * Opens the deployment's memory: the database under `stateDir` when it can be opened, with the Markdown directory as
 * the copy that is always written, or the Markdown directory alone when it cannot.
 * @param onProblem - receives the database failure that selected the fallback, for the plugin log.
 */
export function openMemory(stateDir: string, onProblem: (error: unknown) => void = () => {}): Memory {
  const markdown = new MarkdownMemory(join(stateDir, 'memory'))
  try {
    return new Memory({ database: new SqliteMemory(join(stateDir, 'memory.sqlite')), markdown })
  } catch (error) {
    onProblem(error)
    return new Memory({ markdown, fallback: error instanceof Error ? error.message : String(error) })
  }
}

export { MarkdownMemory, parseMemory, renderMemory } from './markdown.ts'
export { SqliteMemory } from './sqlite.ts'
export { Memory } from './store.ts'
export type { MemoryBackends, MemoryStore } from './store.ts'
export { MEMORY_KINDS, MEMORY_REF, memoryId, memoryRecord, memoryRelation, memoryResource } from './model.ts'
export type { MemoryDraft, MemoryKind, MemoryRecord } from './model.ts'
