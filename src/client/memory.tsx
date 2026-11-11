/** Memory tab: durable memories listed newest first, one memory in full, and the merge and forget actions. */
import { useState } from 'react'
import { ApiError, usePoll, type MemoryRow } from './api.ts'
import { Button, Icon, Input, Modal, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import type { Route } from './route.ts'
import { ConfirmButton, Hint, LoadMore, LoadState, MarkdownLite, PageHead, Section, StatusHead, When } from './widgets.tsx'

/** Where a memory's next hop opens: another memory, its Ticket, its Thread, or the board the object lives on. */
function target(ref: string): Route | undefined {
  const [kind, ...rest] = ref.split('/'), id = rest.join('/')
  return kind === 'memory' ? { page: 'memory', id } : kind === 'ticket' ? { page: 'execution', id }
    : kind === 'thread' ? { page: 'trigger', id } : kind === 'decision' ? { page: 'eval' } : kind === 'trigger' ? { page: 'trigger' }
      : undefined
}

function MemoryLine({ memory, picked, onPick }: { memory: MemoryRow; picked: boolean; onPick: () => void }) {
  const { t, navigate } = usePanel()
  return <li className="dt-row dt-link">
    <div className="dt-ticket-stage">
      <input type="checkbox" checked={picked} onChange={onPick} aria-label={t('memory.select')} title={t('memory.select')} />
    </div>
    <div className="dt-ticket-body">
      <div className="dt-row-title"><button type="button" className="dt-open"
        onClick={() => navigate({ page: 'memory', id: memory.memory_id })}>{memory.title}</button></div>
      <div className="dt-row-meta">
        <Tag tone="quiet">{t(`memoryKind.${memory.kind}`)}</Tag>
        <When at={memory.at} />
        <span>{t('memory.chars', { chars: memory.chars })}</span>
        {memory.tags?.map(tag => <span key={tag} className="dt-chip">#{tag}</span>)}
      </div>
    </div>
  </li>
}

export function MemoryPage({ id, query }: { id?: string; query?: string }) {
  return id === undefined ? <MemoryListPage query={query} /> : <MemoryDetailPage id={id} />
}

function MemoryListPage({ query }: { query?: string }) {
  const { t, call, notify } = usePanel()
  const [q, setQ] = useState(query ?? '')
  const [limit, setLimit] = useState(30)
  const [picked, setPicked] = useState<string[]>([])
  const [merging, setMerging] = useState(false)
  const { data, error, reload } = usePoll(() => call('GET memories', { query: { ...q.trim() ? { q: q.trim() } : {}, limit } }), [q, limit])
  const merge = useAction(() => call('POST memories/merge', { body: { ids: picked } }), { reload })
  const toggle = (id: string) => setPicked(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id])
  const merged = async () => {
    if (await merge.run()) {
      notify(t('memory.merged', { count: picked.length }))
      setPicked([]); setMerging(false)
    }
  }
  return <>
    <StatusHead hint={t('memory.intro')} />
    <div className="dt-filters">
      <Input value={q} placeholder={t('memory.searchPlaceholder')} aria-label={t('memory.searchPlaceholder')}
        onChange={event => { setQ(event.target.value); setLimit(30) }} />
      {picked.length > 1 && <Button variant="outline" icon={<Icon name="copy" />} onClick={() => setMerging(true)}>
        {t('memory.merge')} <span className="dt-count">{picked.length}</span></Button>}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(memory => <MemoryLine key={memory.memory_id}
      memory={memory} picked={picked.includes(memory.memory_id)} onPick={() => toggle(memory.memory_id)} />)}</ul>
      : <Hint>{q.trim() ? t('memory.noMatch', { query: q.trim() }) : t('memory.none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 30)} />}
    <Modal open={merging} onClose={() => setMerging(false)} title={t('memory.mergeTitle')} closeLabel={t('close')}
      description={t('memory.mergeBody', { count: picked.length })}
      footer={<>
        <Button variant="ghost" onClick={() => setMerging(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={merge.busy} onClick={() => void merged()}>{t('memory.merge')}</Button>
      </>}>
    </Modal>
  </>
}

function MemoryDetailPage({ id }: { id: string }) {
  const { t, call, navigate, notify } = usePanel()
  const { data, error } = usePoll(() => call('GET memories/:id', { id }), [id])
  const forgotten = async () => {
    const { removed } = await call('POST memories/:id/forget', { id })
    if (removed) notify(t('memory.forgotten'))
    navigate({ page: 'memory' }, true)
  }
  if (!data) return <><PageHead title={t('tab.memory')} />
    {error instanceof ApiError && error.missing ? <Hint>{t('memory.notFound')}</Hint> : <LoadState error={error} loading />}</>
  return <>
    <PageHead title={data.title}>
      <ConfirmButton variant="outline" icon="trash" label={t('memory.forget')} title={t('memory.forgetTitle')}
        message={t('memory.forgetBody', { title: data.title })} onConfirm={forgotten} />
    </PageHead>
    {error && <LoadState error={error} loading={false} />}
    <div className="dt-row-meta dt-status-line">
      <Tag tone="quiet">{t(`memoryKind.${data.kind}`)}</Tag>
      <When at={data.at} />
      <span>{t('memory.chars', { chars: data.chars })}</span>
      {data.tags?.map(tag => <span key={tag} className="dt-chip">#{tag}</span>)}
    </div>
    <Section title={t('memory.one')}>
      <MarkdownLite text={data.text} />
    </Section>
    {(data.links.length > 0 || data.supersedes.length > 0) && <Section title={t('memory.next')}>
      <ul className="dt-list">
        {data.supersedes.map(memory => <li key={memory} className="dt-row"><span className="dt-row-meta">
          {t('memory.supersedes')} <span className="dt-mono">{memory}</span></span></li>)}
        {data.links.map(link => {
          const route = target(link.read)
          return <li key={`${link.rel}-${link.read}`} className="dt-row">
            <span className="dt-row-meta">{link.rel}</span>
            {route ? <button type="button" className="dt-textlink dt-mono" onClick={() => navigate(route)}>{link.read}</button>
              : <span className="dt-mono">{link.read}</span>}
          </li>
        })}
      </ul>
    </Section>}
    {data.source && <Hint>{t('memory.source', { source: data.source })}</Hint>}
  </>
}
