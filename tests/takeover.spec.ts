/** A person taking a running turn over: the domain records the takeover, and the Session keeps its work and its inbox. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, latestAssignment, runningAssignment } from '../src/core/index.ts'
import type { Assessor, Assignment, Candidate, Executor, Policy, Ticket, Trigger } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const member = { source: 'chat', id: 'alice' }
function trigger(id: string): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`,
    text: `message ${id}`, channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {} }
}

/** The domain alone: an Executor that records what it is asked, so each call is what the ticket asked for. */
function harness() {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  const interrupts: [Ticket, Assignment][] = []
  const stops: [Ticket, Assignment, string][] = []
  const deliveries = new Set<string>()
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }),
    deliver: vi.fn(ticket => { deliveries.add(ticket.id) }),
    stop: vi.fn((ticket, assignment, reason) => { stops.push([ticket, assignment, reason]) }),
    interrupt: vi.fn((ticket, assignment) => { interrupts.push([ticket, assignment]) }),
  }
  let version = 'v1', paused = false
  const policy: Policy = {
    get version() { return version }, get paused() { return paused }, evalTimeoutMs: 60_000,
    gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' } : t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } } : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked',
    admitsInferred: rules => rules.length > 0,
  }
  let clock = 0
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString() })
  /** Simulate the Executor starting queued assignments and delivering pending ticket inputs. */
  function settle() {
    for (;;) {
      const next = launches.shift()
      if (next) { engine.assignmentStarted(next[0].id, next[1].id); continue }
      const [ticketId] = deliveries
      if (ticketId === undefined) return
      deliveries.delete(ticketId)
      const ticket = repo.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (ticket.ended || !assignment) continue
      for (const inputId of ticket.undelivered) engine.inputsDelivered(ticketId, assignment.id, [inputId])
    }
  }
  /** Accept one Trigger, and by default let the Executor start the assignment the Decision makes. */
  function accept(id = '1', start = true) {
    engine.receive(trigger(id)); engine.evaluateDue(); settle()
    const candidate = requests.at(-1)!
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok', evalId: candidate.evalId })
    if (start) settle()
    return decision.ticketId!
  }
  return { repo, engine, executor, launches, interrupts, stops, deliveries, accept, settle, tick: (seconds: number) => { clock += seconds } }
}

describe('interruptTicket', () => {
  it('interrupts the turn the assignment runs, and the assignment, the ticket and what it holds go on', () => {
    const h = harness()
    const ticketId = h.accept()
    const before = h.repo.tickets.get(ticketId)!
    const running = runningAssignment(before)!
    expect(running.state).toBe('running')
    expect(h.engine.interruptTicket(ticketId).id).toBe(running.id)
    expect(h.interrupts.map(([, assignment]) => assignment.id)).toEqual([running.id])
    // Not a stop: nothing ends, and nothing is delivered to wake the worker the person took the work from.
    expect(h.stops).toHaveLength(0)
    expect(h.deliveries.size).toBe(0)
    const after = h.repo.tickets.get(ticketId)!
    expect(after.ended).toBeUndefined()
    expect(after.assignments.map(item => item.state)).toEqual(['running'])
    expect(after.assignments[0]).toMatchObject({ id: running.id, startedAt: running.startedAt })
    expect(after.assignments[0]!.endedAt).toBeUndefined()
    expect(after.assignments[0]!.endedReason).toBeUndefined()
    expect(after.execution).toEqual(before.execution)
    // The trace the panel and the next assignment read, waiting to reach the worker with the next thing that does.
    const note = after.inputs.at(-1)!
    expect(note).toMatchObject({ kind: 'note', at: '2026-09-23T00:00:00.000Z' })
    expect('text' in note ? note.text : '').toMatch(/^A person took over this ticket at 2026-09-23T00:00:00\.000Z and interrupted the turn/)
    expect(after.undelivered).toEqual([note.id])
  })
  it('refuses a ticket that runs no turn, and takes one again once work reaches it', () => {
    const h = harness()
    const ticketId = h.accept()
    const running = runningAssignment(h.repo.tickets.get(ticketId)!)!
    h.engine.turnEnded(ticketId, running.id)
    expect(() => h.engine.interruptTicket(ticketId)).toThrow(new UserError('nothingToInterrupt'))
    expect(h.interrupts).toHaveLength(0)
    expect(h.repo.tickets.get(ticketId)!.inputs.some(input => input.id.includes('takeover'))).toBe(false)
    expect(h.repo.tickets.get(ticketId)!.undelivered).toEqual([])
    // Work that reached it after its turn ended is another turn, which is one a person can interrupt.
    h.tick(1)
    h.engine.note(ticketId, 'A question the ticket has to answer')
    h.settle()
    expect(h.engine.interruptTicket(ticketId).id).toBe(running.id)
  })
  it('refuses a ticket that ended, one whose assignment has not started, and one it does not know', () => {
    const h = harness()
    const ended = h.accept()
    h.engine.stopTicket(ended, 'Not needed after all')
    expect(() => h.engine.interruptTicket(ended)).toThrow(new UserError('ticketEnded'))
    const pending = h.accept('2', false)
    expect(latestAssignment(h.repo.tickets.get(pending)!)!.state).toBe('pending')
    expect(() => h.engine.interruptTicket(pending)).toThrow(new UserError('nothingToInterrupt'))
    expect(() => h.engine.interruptTicket('ticket-nope')).toThrow('Unknown ticket')
    expect(h.interrupts).toHaveLength(0)
  })
})

describe('orchestrator_ticket_interrupt', () => {
  let h: Host
  beforeEach(async () => { h = await startRuntime() })
  afterEach(async () => { await h.stop() })
  const read = (resource: string) => h.runTool(h.runtime.masterId, 'orchestrator_read', { resource })
  const interrupt = (ticketId: string) => h.runTool(h.runtime.masterId, 'orchestrator_ticket_interrupt', { ticket_id: ticketId })

  it('is listed on the main Session, with the one argument it takes and what it leaves alone', async () => {
    type Registered = { description: string; parameters: { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } }
    const tool = h.tools.get(h.runtime.masterId)!.get('orchestrator_ticket_interrupt') as unknown as Registered
    expect(tool.description).toContain('when a person takes the work over')
    expect(tool.description).toContain('its directory and its inbox go on')
    expect(Object.keys(tool.parameters.properties)).toEqual(['ticket_id'])
    expect(tool.parameters.required).toEqual(['ticket_id'])
    expect(tool.parameters.additionalProperties).toBe(false)
    // Taking work over is the main Session's to do: an Executor's toolset does not offer it.
    const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
    expect(h.tools.get(sessionId)!.has('orchestrator_ticket_interrupt')).toBe(false)
  })

  it('interrupts the turn a worker is in, keeps its ticket, its assignment and its inbox, and leaves the takeover on the ticket', async () => {
    const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
    const worker = h.agents.get(sessionId)!
    expect(worker.status).toBe('running')
    // What the Session holds when the person takes over: the launch message, steered in and not yet taken into a step.
    const kept = { nextTurn: worker.inbox.nextTurn.map(message => message.id), nextStep: worker.inbox.nextStep.map(message => message.id) }
    expect(kept).toEqual({ nextTurn: [expect.any(String)], nextStep: [] })
    expect(await interrupt(ticket.id)).toEqual({ reason: 'Interrupted the turn the worker was in; the assignment goes on',
      ticket: expect.objectContaining({ ticket_id: ticket.id }) })
    await h.runtime.idle()
    // A cancel drops the inbox unless it is kept, and this one is kept.
    expect(worker.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect({ nextTurn: worker.inbox.nextTurn.map(message => message.id), nextStep: worker.inbox.nextStep.map(message => message.id) }).toEqual(kept)
    // The ticket, its assignment and its directory go on, and the ticket is not stopped.
    const stored = h.runtime.store.tickets.get(ticket.id)!
    expect(stored.ended).toBeUndefined()
    expect(stored.assignments.map(item => item.state)).toEqual(['running'])
    expect(stored.execution).toEqual(ticket.execution)
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
    // The takeover is a note on the ticket, which the panel pages and the next assignment reads.
    const inputs = await read(`ticket/${ticket.id}/inputs`) as { items: { kind: string; read?: string; undelivered?: boolean }[] }
    expect(inputs.items[0]).toMatchObject({ kind: 'note', undelivered: true, read: expect.stringMatching(new RegExp(`^ticket/${ticket.id}/input/`)) })
    const note = JSON.stringify(await read(inputs.items[0]!.read!))
    expect(note).toContain('A person took over this ticket at')
    expect(note).toContain('and interrupted the turn this assignment was in')
  })

  it('refuses a ticket that runs no turn, and one it does not know, without recording a takeover', async () => {
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
    // The worker's turn ended and nothing reached it since: the ticket is idle, so there is no turn to take over.
    h.runtime.engine.turnEnded(ticket.id, latestAssignment(h.runtime.store.tickets.get(ticket.id)!)!.id)
    await expect(interrupt(ticket.id)).rejects.toThrow(new UserError('nothingToInterrupt'))
    const stored = h.runtime.store.tickets.get(ticket.id)!
    expect(stored.ended).toBeUndefined()
    expect(stored.inputs.some(input => input.id.includes('takeover'))).toBe(false)
    await expect(interrupt('ticket-nope')).rejects.toThrow('Unknown ticket')
  })
})
