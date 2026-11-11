/**
 * Router batch semantics: which queued Intake Triggers one Eval 鈥?and so one assessor request, one main-Session LLM call 鈥? * covers, where the batch boundary lies, and how the batch reaches the worker.
 * The engine path is the real one (`Intake.receive` 鈫?`Evals.start` 鈫?`Assessor.request`), with a fake host as in
 * tests/core-engine.spec.ts: no clock, no filesystem, no subprocess, so it runs the same on Windows and POSIX.
 */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, threadKey } from '../src/core/index.ts'
import type { Assessor, Candidate, EngineOptions, Executor, OutboundMessage, Policy, Trigger } from '../src/core/index.ts'
import { ticketDetails } from '../src/app/cards.ts'
import { batchLine, batchOf } from '../src/executor/dsh.ts'

const member = { source: 'chat', id: 'alice' }
/** A person's chat Trigger on thread `t<thread>`; `at` comes from the seconds in `id` unless overridden. */
function trigger(id: string, thread = 't1', overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: thread }], actor: member, human: true,
    at: `2026-11-11T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`,
    channel: { source: 'chat', thread: `chat:${thread}`, address: { message: id } }, meta: {}, ...overrides }
}
function harness() {
  const repo = new MemoryRepositories()
  /** One entry per assessor request: exactly one per Eval, and one per main-Session LLM call. */
  const requests: Candidate[] = []
  const events: { type: string; data: Record<string, unknown> }[] = []
  const outbox: OutboundMessage[] = []
  const assessor: Assessor = { request: vi.fn((candidate: Candidate) => { requests.push(candidate) }), release: vi.fn() }
  const executor: Executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn(), interrupt: vi.fn() }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => true, admitsInferred: () => true }
  let clock = 0
  const options: EngineOptions = { repo, assessor, executor, emit: event => { events.push(event) },
    policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) }, now: () => new Date(Date.UTC(2026, 10, 11, 0, 0, clock)).toISOString(),
    outbox: { send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
      status: id => outbox.some(item => item.id === id) ? 'pending' : undefined, withdraw: () => {} } }
  const engine = new Engine(options)
  /** One pass of the pump (src/app/passes.ts:63-68 runs `effects.kick` then `Engine.evaluateDue`). */
  const pump = () => { engine.evaluateDue() }
  const started = () => events.filter(event => event.type === 'eval.started').map(event => event.data as { evalId: string; threadKey: string; triggerIds: string[] })
  /** Decide the Eval `candidate` is the first Trigger of; an ignore ends it without starting a ticket. */
  const decide = (candidate: Candidate, outcome: Parameters<Engine['decide']>[1] = { kind: 'ignore', reason: 'chatter' }) =>
    engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  const accept = (candidate: Candidate) => decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })
  const tick = (seconds: number) => { clock += seconds }
  return { repo, engine, requests, events, outbox, assessor, started, pump, decide, accept, tick }
}

describe('one batch per Thread', () => {
  it('merges the Triggers a Thread queued into a single Eval and a single assessor request', () => {
    const h = harness()
    for (const id of ['1', '2', '3', '4']) h.engine.receive(trigger(id))
    expect(h.engine.candidate('1')).toBeUndefined()
    h.pump()
    // One Eval for four Triggers: one card, one assessment, one LLM call.
    expect(h.assessor.request).toHaveBeenCalledOnce()
    expect(h.requests[0]!.triggers.map(item => item.id)).toEqual(['1', '2', '3', '4'])
    expect(h.requests[0]!.thread.key).toBe(threadKey({ source: 'chat', id: 't1' }))
    expect(h.started()).toEqual([expect.objectContaining({ threadKey: 'chat:t1', triggerIds: ['1', '2', '3', '4'] })])
    // The queue hands the whole batch to that one Eval, and every Trigger of it names the same Eval.
    const thread = h.repo.threads.get('chat:t1')!
    expect(thread.pending).toEqual([])
    expect(thread.evaluating!.triggerIds).toEqual(['1', '2', '3', '4'])
    const evalIds = new Set(['1', '2', '3', '4'].map(id => h.repo.triggers.disposition(id)!.evalId))
    expect([...evalIds]).toEqual([h.requests[0]!.evalId])
    // Deciding the batch records one Decision for all four Triggers, and starts no second Eval.
    const decision = h.decide(h.requests[0]!)
    expect(decision.triggerIds).toEqual(['1', '2', '3', '4'])
    expect(h.repo.decisions.byThread('chat:t1')).toHaveLength(1)
    h.pump()
    expect(h.assessor.request).toHaveBeenCalledOnce()
  })
  it('does not merge Triggers of different Threads: the batch boundary is the Thread, not the pass', () => {
    const h = harness()
    h.engine.receive(trigger('1', 't1'))
    h.engine.receive(trigger('2', 't2'))
    h.engine.receive(trigger('3', 't1'))
    h.pump()
    expect(h.assessor.request).toHaveBeenCalledTimes(2)
    expect(h.started().map(event => [event.threadKey, event.triggerIds]).sort()).toEqual([['chat:t1', ['1', '3']], ['chat:t2', ['2']]])
    // No Trigger appears in two Evals, and no Eval covers Triggers of two Threads.
    for (const candidate of h.requests) expect(new Set(candidate.triggers.map(item => threadKey(item.threads[0]!))).size).toBe(1)
    expect(h.requests.flatMap(candidate => candidate.triggers.map(item => item.id)).sort()).toEqual(['1', '2', '3'])
  })
  it('has no time window of its own: Triggers far apart in source time share one Eval when one pass finds them queued', () => {
    const h = harness()
    h.engine.receive(trigger('1', 't1', { at: '2026-11-11T00:00:01.000Z' }))
    h.tick(3 * 60 * 60)
    h.engine.receive(trigger('2', 't1', { at: '2026-11-11T03:00:00.000Z' }))
    h.pump()
    // src/core/evals.ts:107-111 batches `thread.pending` as it stands; only arrival (queueing) decides membership.
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.triggers.map(item => item.id)).toEqual(['1', '2'])
  })
})

describe('a Trigger that arrives while the Thread\'s Eval runs', () => {
  it('waits in the Thread queue and joins the next Eval, in arrival order', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.pump()
    const first = h.requests[0]!
    // The first Eval is still running: its Triggers are held, and later arrivals only reach the queue (src/core/part.ts:57-63).
    for (const id of ['2', '3', '4']) h.engine.receive(trigger(id))
    h.pump()
    expect(h.assessor.request).toHaveBeenCalledOnce()
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2', '3', '4'])
    expect(first.triggers.map(item => item.id)).toEqual(['1'])
    // Ending the first Eval lets the next pass take the backlog as one Eval of its own.
    h.decide(first)
    h.pump()
    expect(h.assessor.request).toHaveBeenCalledTimes(2)
    expect(h.requests[1]!.evalId).not.toBe(first.evalId)
    expect(h.requests[1]!.triggers.map(item => item.id)).toEqual(['2', '3', '4'])
    expect(h.repo.threads.get('chat:t1')!.evaluating!.triggerIds).toEqual(['2', '3', '4'])
  })
  it('keeps the backlog of one Thread out of another Thread\'s Eval that starts meanwhile', () => {
    const h = harness()
    h.engine.receive(trigger('1', 't1'))
    h.pump()
    h.engine.receive(trigger('2', 't1'))
    h.engine.receive(trigger('3', 't2'))
    h.pump()
    expect(h.requests.map(candidate => candidate.triggers.map(item => item.id))).toEqual([['1'], ['3']])
    h.decide(h.requests[0]!)
    h.pump()
    expect(h.requests.map(candidate => candidate.triggers.map(item => item.id))).toEqual([['1'], ['3'], ['2']])
  })
})

describe('the batch on the worker side', () => {
  it('gives the worker of a batch ticket the sibling Triggers of its own Eval as batch lines', () => {
    const h = harness()
    for (const id of ['1', '2', '3']) h.engine.receive(trigger(id))
    h.pump()
    const decision = h.accept(h.requests[0]!)
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    // The batch takes its strength, and its representative Trigger, from the strongest one: on a tie the newest message
    // (src/core/evals.ts:96-99 `later`). Every Trigger of the Eval is in the origin, so the rest is the sibling batch.
    expect(ticket.origin).toEqual({ triggerId: '3', triggerIds: ['1', '2', '3'] })
    // batchOf/batchLine are what src/executor/dsh.ts:460-464 puts in a worker's first message and src/app/cards.ts:63 on its ticket.
    const host = { store: { triggers: h.repo.triggers } }
    const siblings = batchOf(host, ticket)
    expect(siblings.map(item => item.id)).toEqual(['1', '2'])
    expect(siblings.map(batchLine)).toEqual([
      { trigger_id: '1', from: 'alice', at: '2026-11-11T00:00:01.000Z', preview: 'message 1', read: 'trigger/1' },
      { trigger_id: '2', from: 'alice', at: '2026-11-11T00:00:02.000Z', preview: 'message 2', read: 'trigger/2' },
    ])
    // The ticket card a worker reads carries the same lines, and names the Trigger the batch took its strength from.
    const details = ticketDetails(ticket, [{ thread: 'chat:t1', bound: true }], siblings, true)
    expect(details).toMatchObject({ trigger_id: '3', batch: siblings.map(batchLine) })
    expect(details).not.toHaveProperty('decision_id')
  })
  it('leaves the batch out of a ticket card accepted from a single-Trigger Eval', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.pump()
    const ticket = h.repo.tickets.get(h.accept(h.requests[0]!).ticketId!)!
    expect(ticket.origin.triggerIds).toEqual(['1'])
    const siblings = batchOf({ store: { triggers: h.repo.triggers } }, ticket)
    expect(siblings).toEqual([])
    expect(ticketDetails(ticket, [], siblings, true)).not.toHaveProperty('batch')
  })
})
