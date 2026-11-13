/** Router views: one router per workspace, its tickets, and the threads and workers subscribed to them. */
import { key, liveTicket, type Ticket } from '../../core/index.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import type { Store } from '../store.ts'
import { newestFirst, snapshot, threadSummary, ticketLine, type ViewHost } from './records.ts'
import { preview } from './text.ts'
import { ticketRow } from './tickets.ts'

/** Stable id of the router that serves `workspace`; equal workspaces always produce the same id. */
export const routerId = (workspace: string): string => key('router', workspace)
/** Display name of a workspace: its last path segment, which is what a person recognizes. */
export function workspaceTitle(workspace: string): string {
  const parts = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? workspace
}
/** One row of the router list: its workspace, how much work it holds, and when it was last active. */
export function routerRow(workspace: string, tickets: Ticket[]) {
  const open = tickets.filter(liveTicket)
  const running = open.filter(ticket => ticket.assignments.some(item => item.state === 'running')).length
  const lastAt = tickets.map(ticket => ticket.updatedAt).sort().at(-1) ?? ''
  return { id: routerId(workspace), workspace, title: workspaceTitle(workspace), total: tickets.length, open: open.length,
    running, lastAt }
}
export type RouterRowView = ReturnType<typeof routerRow>
/**
 * Every router: one per workspace that has held work, plus the default router for work whose Source names no workspace
 * (GitHub, Feishu). Tickets accepted before tickets recorded their workspace join the default one.
 */
export function routerList(host: ViewHost, fallbackWorkspace: string) {
  const groups = new Map<string, Ticket[]>()
  for (const ticket of host.store.tickets.list()) {
    const workspace = ticket.workspace ?? fallbackWorkspace
    groups.set(workspace, [...groups.get(workspace) ?? [], ticket])
  }
  const items = [...groups.entries()].map(([workspace, tickets]) => routerRow(workspace, tickets))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
  return { items, total: items.length, next_offset: null as number | null }
}
export type RouterListView = ReturnType<typeof routerList>
/** The worker Session of a ticket: its id once any assignment started, whether it runs now, and the latest report's first line. */
function worker(ticket: Ticket) {
  const running = ticket.assignments.some(item => item.state === 'running')
  const started = ticket.assignments.find(item => item.startedAt !== undefined)
  const summary = ticket.assignments.at(-1)?.report?.summary
  return { sessionId: started ? workerSessionId(ticket.id) : '', running, ...summary ? { report: preview(summary, 160) } : {} }
}
/**
 * One router: its workspace, its tickets by recency with the worker Session of each, and every thread its tickets are
 * subscribed to. A worker belongs to its ticket; the threads are what the tickets (and through them their workers) follow.
 */
export function routerDetail(host: ViewHost, id: string, fallbackWorkspace: string) {
  const { store } = host
  const view = snapshot(host)
  const tickets = store.tickets.list().filter(ticket => routerId(ticket.workspace ?? fallbackWorkspace) === id)
  if (!tickets.length) return undefined
  const workspace = tickets[0]!.workspace ?? fallbackWorkspace
  const rows = tickets.sort(newestFirst)
  const threads = new Map<string, { key: string; title: string; stage: string; subscriptions: number }>()
  for (const ticket of rows) for (const thread of view.threadsOf(ticket.id)) {
    const summary = threadSummary(view, thread)
    threads.set(summary.key, { key: summary.key, title: summary.title, stage: summary.stage, subscriptions: summary.subscriptions })
  }
  return { ...routerRow(workspace, tickets),
    tickets: rows.map(ticket => ({ ...ticketRow(view, ticket), worker: worker(ticket) })),
    threads: [...threads.values()] }
}
export type RouterDetailView = NonNullable<ReturnType<typeof routerDetail>>
