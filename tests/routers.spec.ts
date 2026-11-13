import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { chatTrigger } from '../src/sources/chat.ts'
import { routerDetail, routerId, routerList, workspaceTitle } from '../src/app/views/routers.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-routers-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const host = () => ({ store, sources: new SourceRegistry(() => store.settings()), links: () => ({ url: '', label: { zh: '', en: '' } }) })
const at = '2026-11-13T00:00:00.000Z'
function ticket(id: string, workspace: string | undefined, started = false) {
  store.tickets.save({ id, title: id, decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    ...workspace ? { workspace } : {},
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'chat', id: 'operator' }, scope: '' },
    origin: { triggerId: `chat:s:${id}`, triggerIds: [`chat:s:${id}`] },
    assignments: started ? [{ id: `a-${id}`, state: 'running', createdAt: at, startedAt: at }] : [], inputs: [] })
}
function subscribe(thread: string, ...tickets: string[]) {
  store.threads.save({ key: thread, ref: { source: 'chat', id: thread.split(':')[1]! }, createdAt: at, subscriptions: tickets,
    correlated: [], pending: [], meta: {} })
}

it('groups tickets by the workspace that names their router, and puts workspace-less work in the default router', () => {
  ticket('a', 'C:\\work\\app')
  ticket('b', 'C:\\work\\app', true)
  ticket('c', undefined)
  const list = routerList(host(), '/srv/state')
  expect(list.items.map(item => [item.workspace, item.total, item.open]).sort()).toEqual([
    ['C:\\work\\app', 2, 2], ['/srv/state', 1, 1]].sort())
  expect(routerId('C:\\work\\app')).toBe(routerId('C:\\work\\app'))
  expect(routerId('C:\\work\\app')).not.toBe(routerId('C:\\work\\other'))
})

it('names a router after its workspace\'s last path segment', () => {
  expect(workspaceTitle('C:\\work\\app')).toBe('app')
  expect(workspaceTitle('/srv/state/')).toBe('state')
})

it('lists one router\'s tickets with the worker Session that runs each and the threads they subscribe to', () => {
  ticket('a', 'C:\\work\\app', true)
  ticket('b', 'C:\\work\\other')
  subscribe('chat:s', 'a')
  const detail = routerDetail(host(), routerId('C:\\work\\app'), '/srv/state')!
  expect(detail.workspace).toBe('C:\\work\\app')
  expect(detail.tickets.map(item => item.id)).toEqual(['a'])
  expect(detail.tickets[0]!.worker).toMatchObject({ running: true, sessionId: expect.stringContaining('a') })
  expect(detail.threads.map(thread => thread.key)).toEqual(['chat:s'])
})

it('has no detail for a router id no ticket names', () => {
  ticket('a', 'C:\\work\\app')
  expect(routerDetail(host(), routerId('C:\\work\\other'), '/srv/state')).toBeUndefined()
})

it('gives a Session\'s message the workspace its router is named after', () => {
  const trigger = chatTrigger('session-1', { id: 'm1', text: 'do it', at }, 'C:\\work\\app')
  expect(trigger.meta).toMatchObject({ session: 'session-1', workspace: 'C:\\work\\app' })
  expect(chatTrigger('session-1', { id: 'm1', text: 'do it', at }).meta).not.toHaveProperty('workspace')
})
