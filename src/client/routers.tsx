/** Routers page: one router per workspace, its tickets, and the threads and workers subscribed to them. */
import { usePoll } from './api.ts'
import type { RouterPageView, RouterRow } from './api.ts'
import { ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { Section, LoadState, Hint, StageMark, SessionButton, When } from './widgets.tsx'

/** One router row: its workspace, how much work it holds, and when it was last active. */
function RouterLine({ router }: { router: RouterRow }) {
  const { t, navigate } = usePanel()
  return <li className="dt-row dt-link">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <button type="button" className="dt-open" onClick={() => navigate({ page: 'routers', id: router.id })}>{router.title}</button>
      </div>
      <div className="dt-row-meta dt-line"><span className="dt-hint dt-mono">{router.workspace}</span></div>
      <div className="dt-row-meta dt-line">
        <span>{t('routerTickets', { count: router.total })}</span>
        <span>{t('routerOpen', { count: router.open })}</span>
        {router.running > 0 && <span>{t('routerRunning', { count: router.running })}</span>}
        {router.lastAt && <When at={router.lastAt} />}
      </div>
    </div>
  </li>
}

/** The workspaces this deployment serves, one router each; a workspace appears once its first ticket exists. */
export function RouterIndex() {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET routers'), [])
  if (!data) return <LoadState error={error} loading />
  return <Section title={t('tab.routers')} count={data.items.length}>
    {data.items.length ? <ul className="dt-list dt-cards">{data.items.map(router => <RouterLine key={router.id} router={router} />)}</ul>
      : <Hint>{t('routerEmpty')}</Hint>}
  </Section>
}

/** One router: its tickets, each with the worker Session that runs it and the threads it is subscribed to. */
export function RouterPage({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET routers/:id', { id }), [id])
  if (!data) return <LoadState error={error} loading />
  const view: RouterPageView = data
  return <>
    <Section title={view.title} count={view.tickets.length}>
      <div className="dt-stats">
        <span className="dt-stat"><span className="dt-stat-label">{t('routerWorkspace')}</span><span
          className="dt-stat-value dt-mono">{view.workspace}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('routerOpenLabel')}</span><span
          className="dt-stat-value">{view.open}</span></span>
        <span className="dt-stat"><span className="dt-stat-label">{t('routerRunningLabel')}</span><span
          className="dt-stat-value">{view.running}</span></span>
      </div>
    </Section>
    <Section title={t('term.tickets')} count={view.tickets.length}>
      {view.tickets.length ? <ul className="dt-list dt-cards">{view.tickets.map(ticket => {
        const mark = ticketMark(t, ticket)
        return <li key={ticket.id} className="dt-row dt-link dt-ticket">
          <div className="dt-ticket-stage"><StageMark state={mark.dot} icon={mark.icon} label={mark.label} /></div>
          <div className="dt-ticket-body">
            <div className="dt-row-title"><button type="button" className="dt-open"
              onClick={() => navigate({ page: 'execution', id: ticket.id })}>{ticket.title}</button></div>
            <div className="dt-row-meta dt-ticket-meta">
              {ticket.threads.map(thread => <button key={thread.key} type="button" className="dt-chip dt-chip-link dt-ellipsis"
                title={thread.title} onClick={() => navigate({ page: 'trigger', id: thread.key })}>{thread.title}</button>)}
              {ticket.worker.sessionId && <SessionButton variant="outline" sessionId={ticket.worker.sessionId} />}
              {ticket.worker.running && <span className="dt-hint">{t('routerWorkerRunning')}</span>}
              <When at={ticket.updatedAt} />
            </div>
            {ticket.worker.report && <div className="dt-row-quote dt-line">{ticket.worker.report}</div>}
          </div>
        </li>
      })}</ul> : <Hint>{t('routerEmpty')}</Hint>}
    </Section>
    <Section title={t('routerThreads')} count={view.threads.length}>
      {view.threads.length ? <ul className="dt-list dt-cards">{view.threads.map(thread => <li key={thread.key} className="dt-row dt-link dt-ticket">
        <div className="dt-ticket-body">
          <div className="dt-row-title"><button type="button" className="dt-open"
            onClick={() => navigate({ page: 'trigger', id: thread.key })}>{thread.title}</button></div>
          <div className="dt-row-meta dt-line"><span>{t('routerSubscriptions', { count: thread.subscriptions })}</span></div>
        </div>
      </li>)}</ul> : <Hint>{t('routerNoThreads')}</Hint>}
    </Section>
  </>
}
