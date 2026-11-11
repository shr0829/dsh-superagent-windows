import { expect, it } from 'vitest'
import { readResource, type MainResourceHost } from '../src/app/resources.ts'
import type { Decision, Thread, Ticket, Trigger } from '../src/core/index.ts'

/**
 * Chain of Recall (docs upstream 3.3): every projection names the resources of the objects it stands for, so a reader expands
 * one hop at a time and only the hops it asks for leave the store. These tests read real resources through the same router the
 * tools use and follow the links a model would follow.
 */
const trigger: Trigger = { id: 'request-1', source: 'github', threads: [{ source: 'github', id: '42' }], actor: { source: 'github', id: 'alice' },
  human: true, at: '2026-09-09T00:00:00Z', text: 'Please inspect the failing check.', meta: {} }
const decision: Decision = { id: 'd1', evalId: 'e1', threadKey: 'github:42', triggerIds: ['request-1'], policyVersion: 'v1', at: 'a',
  kind: 'accept', reason: [], strength: 'explicit', ticketId: 'ticket-1', audit: { matches: [] } }
const ticket: Ticket = { id: 'ticket-1', title: 'Inspect failing check', decisionId: 'd1', channels: [], inputs: [], undelivered: [],
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'Alice' }, actor: trigger.actor, scope: 'small' },
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-09T00:00:00Z', startedAt: '2026-09-09T00:00:00Z',
    report: { state: 'ready', summary: 'Done.', at: '' } }],
  createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
  origin: { triggerId: 'request-1', triggerIds: ['request-1'] },
  execution: { name: 'ticket-1', directory: 'C:/work/ticket-1', assignment: 'Inspect the check.' },
  follows: [{ thread: 'github:42', own: true }] }
const thread: Thread = { key: 'github:42', ref: { source: 'github', id: '42' }, createdAt: '', subscriptions: ['ticket-1'],
  correlated: [], pending: [], meta: {} }

/** A host serving the fixtures above, with the disposition and threads a caller chooses. */
function hostOf(options: { disposition?: { fanout: string[]; evalId: string; decisionId: string; at: string }; neighbours?: { before?: Trigger; after?: Trigger } } = {}) {
  const triggers = [trigger]
  const store = {
    triggers: { get: (id: string) => triggers.find(item => item.id === id), disposition: () => options.disposition },
    tickets: { get: (id: string) => id === ticket.id ? ticket : undefined },
    threads: { get: (key: string) => key === thread.key ? thread : undefined },
    decisions: { get: (id: string) => id === decision.id ? decision : undefined, byThread: () => [decision] },
    read: { neighbours: () => options.neighbours ?? {}, threadPage: () => triggers, subscribedThreads: () => [thread],
      recentTriggers: () => triggers, recentDecisions: () => [decision], firstTrigger: () => trigger },
    replyStatus: () => undefined,
    settings: () => ({}),
  }
  return { store, pages: { get: () => undefined, set: () => {} }, prompts: {}, commands: {}, masterId: 'main',
    context: { sessionController: { inspect: async () => ({ events: [] }) } },
    promptVersion: () => ({ revision: 0, config: {} }), mayRead: () => true, feishuPageSize: () => 20,
    sourceLink: async () => ({}), sessions: { modelRetry: () => ({}), status: () => ({}) }, settings: { view: () => ({}), block: () => ({}) },
  } as unknown as MainResourceHost
}
/** The link a projection names for `rel`, or undefined when the object is not there. */
const hop = (projection: unknown, rel: string) => (projection as { links?: { rel: string; read: string }[] }).links?.find(item => item.rel === rel)?.read

it('names the neighbours of a trigger, and every hop that names a resource is one the router serves', async () => {
  const host = hostOf({ disposition: { fanout: ['ticket-1'], evalId: 'e1', decisionId: 'd1', at: '' } })
  const read = await readResource(host, 'trigger/request-1', 0, undefined)
  expect(hop(read, 'thread')).toBe('thread/github:42')
  expect(hop(read, 'decision')).toBe('decision/d1')
  expect(hop(read, 'ticket')).toBe('ticket/ticket-1')
  // Each named resource is one the same router serves: no link leads to a dead end.
  for (const link of (read as { links: { read: string }[] }).links) await expect(readResource(host, link.read, 0, undefined)).resolves.toBeTruthy()
})

it('walks trigger → thread → ticket → trigger, closing the chain with the object it started from', async () => {
  const host = hostOf({ disposition: { fanout: ['ticket-1'], evalId: 'e1', decisionId: 'd1', at: '' } })
  const triggerRead = await readResource(host, 'trigger/request-1', 0, undefined)
  const threadRead = await readResource(host, hop(triggerRead, 'thread')!, 0, undefined)
  expect(hop(threadRead, 'ticket')).toBe('ticket/ticket-1')
  expect(hop(threadRead, 'decision')).toBe('decision/d1')
  const ticketRead = await readResource(host, hop(threadRead, 'ticket')!, 0, undefined) as { trigger_id: string; threads: { thread: string }[] }
  // A ticket names its trigger and threads by id rather than by link, so its own page stays one page; those ids are the way back.
  expect([ticketRead.trigger_id, ticketRead.threads[0]?.thread]).toEqual(['request-1', 'github:42'])
  const back = await readResource(host, `trigger/${ticketRead.trigger_id}`, 0, undefined)
  expect(back).toEqual(triggerRead)
  expect(await readResource(host, `thread/${ticketRead.threads[0]?.thread}`, 0, undefined)).toMatchObject({ thread: 'github:42' })
  // The decision closes on the ticket it created and the trigger it decided.
  const decisionRead = await readResource(host, hop(triggerRead, 'decision')!, 0, undefined)
  expect([hop(decisionRead, 'ticket'), hop(decisionRead, 'trigger'), hop(decisionRead, 'thread')])
    .toEqual(['ticket/ticket-1', 'trigger/request-1', 'thread/github:42'])
})

it('leaves out a link whose target is not there, instead of naming a resource that is not served', async () => {
  const read = await readResource(hostOf(), 'trigger/request-1', 0, undefined)
  expect(hop(read, 'thread')).toBe('thread/github:42')
  expect(hop(read, 'decision')).toBeUndefined()
  expect(hop(read, 'ticket')).toBeUndefined()
  expect(hop(read, 'replied_to')).toBeUndefined()
})

it('names the messages around a trigger without naming any a worker may not reach', async () => {
  const before = { ...trigger, id: 'request-0', text: 'Earlier.' }
  const read = await readResource(hostOf({ neighbours: { before } }), 'trigger/request-1', 0, undefined)
  expect(hop(read, 'around_before')).toBe('trigger/request-0')
  expect(hop(read, 'around_after')).toBeUndefined()
})

it('hides the decision from a worker Session, which reads no Decision', async () => {
  const host = hostOf({ disposition: { fanout: ['ticket-1'], evalId: 'e1', decisionId: 'd1', at: '' } })
  const read = await readResource(host, 'trigger/request-1', 0, undefined, 'ticket-1')
  expect(hop(read, 'decision')).toBeUndefined()
  // Its own ticket stays reachable, and no other ticket is named.
  expect(hop(read, 'ticket')).toBe('ticket/ticket-1')
  expect(JSON.stringify(read)).not.toMatch(/"d1"/)
})

it('reaches a ticket\'s report and transcript from the ticket itself', async () => {
  const read = await readResource(hostOf({ disposition: { fanout: ['ticket-1'], evalId: 'e1', decisionId: 'd1', at: '' } }), 'ticket/ticket-1', 0, undefined) as
    { assignments: { items: { report?: { read: string } }[] }; transcript: string; result: string }
  const assignments = read.assignments.items
  expect(assignments[0]?.report?.read).toBe('ticket/ticket-1/report/a1')
  expect([read.transcript, read.result]).toEqual(['ticket/ticket-1/transcript', 'ticket/ticket-1/result'])
  for (const target of [assignments[0]!.report!.read, read.transcript, read.result]) {
    await expect(readResource(hostOf(), target, 0, undefined)).resolves.toBeTruthy()
  }
})
