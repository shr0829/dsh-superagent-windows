/**
 * Sessions the Orchestrator creates belong to no DSH Workspace: DSH's workspace list stays the person's own, and the
 * Orchestrator panel shows the main Session and each ticket itself.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ROUTER_PRESET, WORKER_PRESET } from '../src/app/sessions.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

describe('workspaces', () => {
  let host: Host
  afterEach(async () => { await host?.stop() })

  /** Every request the Orchestrator made to create a Session, in the order it made them. */
  const created = (h: Host) => h.controller.create.mock.calls.map(([request]) => request as Record<string, unknown>)
  /** The one request that created `sessionId`. */
  const creating = (h: Host, sessionId: string) => {
    const request = created(h).find(item => item.sessionId === sessionId)
    if (!request) throw new Error(`no Session was created as ${sessionId}`)
    return request
  }

  it('opens the main Session at the state directory without adding a Workspace to DSH\'s list', async () => {
    host = await startRuntime()
    const request = creating(host, host.runtime.masterId)
    expect(request).toMatchObject({ cwd: host.directory, agentPreset: ROUTER_PRESET })
    // A Workspace is what puts a Session in DSH's workspace list; `cwd` alone leaves it out.
    expect(request).not.toHaveProperty('workspaceId')
  })

  it('opens a ticket\'s worker Session at the ticket directory, and no Workspace for the ticket', async () => {
    host = await startRuntime()
    const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
    const request = creating(host, sessionId)
    expect(request).toMatchObject({ cwd: ticket.execution?.directory, agentPreset: WORKER_PRESET })
    expect(request).not.toHaveProperty('workspaceId')
    // Whatever the Orchestrator opens, DSH's workspace list gains nothing.
    expect(created(host).filter(item => 'workspaceId' in item)).toEqual([])
  })
})
