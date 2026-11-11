import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readResource, type MainResourceHost } from '../src/app/resources.ts'
import { memoryCard } from '../src/app/cards.ts'
import { MarkdownMemory, Memory, MEMORY_REF, openMemory, parseMemory, renderMemory, memoryRecord } from '../src/memory/index.ts'

/**
 * Durable memory has two forms: the SQLite database is the default, and the Markdown directory is both the readable copy
 * and the whole store when no database opens. Recall follows the chain (docs upstream 3.3): a card inlines the summary
 * and the next hops, the body stays behind `memory/<id>`, and a hop that no longer exists is dropped rather than linked.
 */
const state = () => mkdtempSync(join(tmpdir(), 'memory-'))

/** A host with only what the memory resources read: the memory facade and the work objects its hops may name. */
const hostOf = (memory: Memory, work: { tickets?: string[]; threads?: string[]; decisions?: string[]; triggers?: string[] } = {}) => ({
  memory,
  store: { threads: { get: (id: string) => work.threads?.includes(id) ? { key: id } : undefined },
    tickets: { get: (id: string) => work.tickets?.includes(id) ? { id } : undefined },
    decisions: { get: (id: string) => work.decisions?.includes(id) ? { id } : undefined },
    triggers: { get: (id: string) => work.triggers?.includes(id) ? { id } : undefined } },
  pages: { get: () => undefined, set: () => {} },
  prompts: {}, commands: {}, masterId: 'main', context: {},
  settings: { view: () => ({}), block: () => ({}) },
} as unknown as MainResourceHost)
const hop = (projection: unknown, rel: string) => (projection as { links?: { rel: string; read: string }[] }).links?.find(item => item.rel === rel)?.read

it('round-trips one memory through its Markdown file, including characters YAML would mangle', () => {
  const record = memoryRecord({ title: 'Feishu 表格: 列名用中文', text: '第一行\n---\n第二行: "quoted"', kind: 'lesson',
    tags: ['feishu', '中文'], next: ['memory/mem_1', 'ticket/ticket-1'], source: 'ticket/ticket-1', thread: 'feishu:doc-1' },
  '2026-09-09T00:00:00.000Z', 'mem_00000001')
  expect(parseMemory(renderMemory(record))).toEqual(record)
  expect(parseMemory('no front matter')).toBeUndefined()
  expect(parseMemory('---\ntitle: "no id"\n---\nbody')).toBeUndefined()
})

it('writes every save to the database and to the Markdown copy, and reads either back', () => {
  const directory = state()
  const memory = openMemory(directory)
  const record = memoryRecord({ title: 'The panel binds 127.0.0.1', text: 'Only the loopback interface.' }, '2026-09-09T00:00:00.000Z', 'mem_00000002')
  expect(memory.save(record).backends).toEqual(['database', 'markdown'])
  expect(memory.status()).toEqual({ database: true, markdown: true })
  expect(memory.get(record.id)).toEqual(record)
  expect(readdirSync(join(directory, 'memory'))).toEqual([`${record.id}.md`])
  expect(readFileSync(join(directory, 'memory', `${record.id}.md`), 'utf8')).toContain('The panel binds 127.0.0.1')
  // The Markdown directory alone already carries what was saved: no database, no loss.
  expect(new MarkdownMemory(join(directory, 'memory')).get(record.id)).toEqual(record)
  memory.close()
})

it('keeps recall working on Markdown alone when the memory database cannot be opened', () => {
  const directory = state()
  // A directory where the database file should be makes SQLite fail to open, which is the fallback path.
  mkdirSync(join(directory, 'memory.sqlite'))
  const problems: unknown[] = []
  const memory = openMemory(directory, error => problems.push(error))
  expect(problems).toHaveLength(1)
  expect(memory.status().database).toBe(false)
  expect(memory.status().fallback).toBeTruthy()
  const record = memoryRecord({ title: 'Works without a database', text: 'Markdown carries it.' }, '2026-09-09T00:00:00.000Z', 'mem_00000003')
  expect(memory.save(record).backends).toEqual(['markdown'])
  expect(memory.get(record.id)).toEqual(record)
  memory.close()
})

it('merges the two forms by id, with the database copy winning and older Markdown entries still recallable', () => {
  const directory = state()
  const markdown = new MarkdownMemory(join(directory, 'memory'))
  markdown.save(memoryRecord({ title: 'Older copy', text: 'From Markdown.' }, '2026-09-08T00:00:00.000Z', 'mem_00000004'))
  markdown.save(memoryRecord({ title: 'Markdown only', text: 'Written before the database existed.' }, '2026-09-07T00:00:00.000Z', 'mem_00000005'))
  const memory = openMemory(directory)
  memory.save(memoryRecord({ title: 'Newer copy', text: 'From the database.' }, '2026-09-09T00:00:00.000Z', 'mem_00000004'))
  expect(memory.get('mem_00000004')?.title).toBe('Newer copy')
  expect(memory.all().map(record => record.id)).toEqual(['mem_00000004', 'mem_00000005'])
  memory.close()
})

it('serves cards with the next hop inlined, and drops a hop whose target is gone', async () => {
  const memory = openMemory(state())
  memory.save(memoryRecord({ title: 'Recall follows one hop at a time', text: 'First memory body with more than one page of detail.' },
    '2026-09-09T00:00:00.000Z', 'mem_00000006'))
  memory.save(memoryRecord({ title: 'The hop it continues', text: 'Second memory body.', next: ['memory/mem_00000006', 'ticket/ticket-gone'] },
    '2026-09-09T00:00:01.000Z', 'mem_00000007'))
  const host = hostOf(memory)
  const list = await readResource(host, 'memories', 0, 10) as { items: unknown[] }
  const cards = list.items
  expect(cards).toHaveLength(2)
  expect(cards[0]).toMatchObject({ memory_id: 'mem_00000007', read: 'memory/mem_00000007' })
  const first = await readResource(host, 'memory/mem_00000007', 0, undefined) as { text: string; next: string[] }
  expect(hop(first, 'continues')).toBe('memory/mem_00000006')
  // The ticket hop named by the entry does not exist, so the chain does not pretend it does.
  expect(hop(first, 'ticket')).toBeUndefined()
  expect(first.next).toEqual(['memory/mem_00000006', 'ticket/ticket-gone'])
  const next = await readResource(host, hop(first, 'continues')!, 0, undefined) as { text: string }
  expect(next.text).toBe('First memory body with more than one page of detail.')
  // The card of a memory keeps the read path; the resource itself drops it, so walking the chain never loops on one entry.
  expect(memoryCard(memory.get('mem_00000006')!).read).toBe('memory/mem_00000006')
  expect(first).not.toHaveProperty('read')
  memory.close()
})

it('links back to the ticket it came from and on to a thread whose key carries colons', async () => {
  const memory = openMemory(state())
  memory.save(memoryRecord({ title: 'The panel binds 127.0.0.1', text: 'Decided on ticket-1.',
    source: 'ticket/ticket-1', next: ['thread/feishu:oc_team:om_1'] }, '2026-09-09T00:00:00.000Z', 'mem_00000010'))
  const host = hostOf(memory, { tickets: ['ticket-1'], threads: ['feishu:oc_team:om_1'] })
  const page = await readResource(host, 'memory/mem_00000010', 0, undefined)
  expect(hop(page, 'source')).toBe('ticket/ticket-1')
  expect(hop(page, 'thread')).toBe('thread/feishu:oc_team:om_1')
  // The tool's grammar accepts a real thread key, which carries colons, and still refuses one that names a part.
  expect(MEMORY_REF.test('thread/feishu:oc_team:om_1')).toBe(true)
  expect(MEMORY_REF.test('thread/feishu:oc_team/om_1')).toBe(false)
  memory.close()
})

it('spills a long body and pages it, so recall never reads a whole memory unasked', async () => {
  const memory = openMemory(state())
  const text = 'abcdefghijklmnopqrstuvwxyz'
  memory.save(memoryRecord({ title: 'A long entry', text }, '2026-09-09T00:00:00.000Z', 'mem_00000011'))
  const host = hostOf(memory)
  const list = await readResource(host, 'memories', 0, 10) as { items: { chars: number; text?: string }[] }
  expect(list.items[0]).toMatchObject({ chars: text.length })
  expect(list.items[0]!.text).toBeUndefined()
  const first = await readResource(host, 'memory/mem_00000011', 0, 10) as { text: string; total_chars: number; next_offset: number | null }
  expect([first.text, first.total_chars, first.next_offset]).toEqual([text.slice(0, 10), text.length, 10])
  const rest = await readResource(host, 'memory/mem_00000011', 10, 100) as { text: string; next_offset: number | null }
  expect([rest.text, rest.next_offset]).toEqual([text.slice(10), null])
  memory.close()
})

it('searches title, body, tags, thread and ticket by words, newest first', () => {
  const memory = openMemory(state())
  memory.save(memoryRecord({ title: 'Deployment lives on Windows', text: 'PowerShell 5.1 only.', tags: ['windows'] },
    '2026-09-09T00:00:00.000Z', 'mem_00000008'))
  memory.save(memoryRecord({ title: 'Feishu tables', text: 'Column names in Chinese.', thread: 'feishu:doc-1' },
    '2026-09-09T00:00:01.000Z', 'mem_00000009'))
  expect(memory.search('powershell').map(record => record.id)).toEqual(['mem_00000008'])
  expect(memory.search('windows feishu').map(record => record.id)).toEqual([])
  expect(memory.search('feishu doc-1').map(record => record.id)).toEqual(['mem_00000009'])
  expect(memory.search('PowerShell 5.1').map(record => record.id)).toEqual(['mem_00000008'])
  memory.close()
})
