/**
 * The chat channel: a person's message in a DSH Session becomes a Trigger on a `chat:` Thread, the answer returns to the
 * Session it was written in, and neither the orchestrator's own Sessions nor a subagent's prompts are mistaken for people.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import type { Trigger } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { CHAT_ACTOR, CHAT_POLICY, CHAT_SOURCE, chatAccepts, chatKind, chatMessage, chatTrigger } from '../src/sources/chat.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

/** A person's message as DSH's user RPC writes it, and the plugin's own relays as `deliver` writes those. */
const person = (text: string, id = 'm1') => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const relay = (text: string, id = 'm2') => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-superagent', form: 'relay' } })
const message = (data: unknown) => ({ type: 'user/message', data }) as never
const session = (id: string, header: Record<string, unknown> = {}) => ({ id, header }) as unknown as Pick<Session, 'id' | 'header'>

describe('chat messages', () => {
  it('takes a person\'s message, joining its text blocks, and ignores everything else a Session carries', () => {
    expect(chatMessage(message(person(' fix the login bug ')), 'now')).toEqual({ id: 'm1', text: 'fix the login bug', at: 'now' })
    expect(chatMessage({ type: 'user/message', data: { id: 'm3', role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], source: { kind: 'user' } } } as never))
      .toMatchObject({ id: 'm3', text: 'one\ntwo' })
    // The plugin's own relays and notices, a tool's messages, and anything that is not a user message are not requests.
    expect(chatMessage(message(relay('candidate: fix the login bug')))).toBeUndefined()
    expect(chatMessage(message({ id: 'm4', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'tool-jobs' } }))).toBeUndefined()
    expect(chatMessage(message({ id: 'm5', role: 'assistant', content: [{ type: 'text', text: 'x' }], source: { kind: 'model' } }))).toBeUndefined()
    expect(chatMessage(message(person('   ')))).toBeUndefined()
    expect(chatMessage({ type: 'assistant/message', data: {} } as never)).toBeUndefined()
  })
  it('makes a Trigger on one Thread per Session, addressed to the agent, with the Session as its Channel', () => {
    expect(chatTrigger('person-1', { id: 'm1', text: 'fix the login bug', at: '2026-09-09T00:00:00.000Z' })).toEqual({
      id: 'chat:person-1:m1', source: CHAT_SOURCE, threads: [{ source: CHAT_SOURCE, id: 'person-1' }],
      actor: { source: CHAT_SOURCE, id: CHAT_ACTOR }, human: true, addressed: 'direct', at: '2026-09-09T00:00:00.000Z',
      text: 'fix the login bug', channel: { source: CHAT_SOURCE, thread: 'person-1', address: { session: 'person-1' } },
      meta: { session: 'person-1', message: 'm1' } })
  })
})

describe('chat scope', () => {
  const ctx = (config: Record<string, never> | undefined, owns: (id: string) => boolean) =>
    ({ config: <C,>(_id: string) => config as C | undefined, owns })
  it('accepts only a person\'s own Session: not the orchestrator\'s, not a worker\'s, not a subagent\'s', () => {
    expect(chatAccepts(ctx({}, () => false), session('person-1'))).toBe(true)
    expect(chatAccepts(ctx(undefined, () => false), session('person-1'))).toBe(false)
    expect(chatAccepts(ctx({}, id => id === 'orchestrator-1'), session('orchestrator-1'))).toBe(false)
    expect(chatAccepts(ctx({}, () => false), session('child-1', { origin: 'subagent', parentSession: 'person-1', delegationDepth: 1 }))).toBe(false)
    expect(chatAccepts(ctx({}, () => false), session('fork-1', { parentSession: 'person-1' }))).toBe(false)
  })
  it('listens to every Trigger it makes and observes nothing else', () => {
    expect(chatKind.scope!({ meta: {} } as never, {} as never)).toEqual({ listened: true, observed: false })
  })
})

describe('chat channel', () => {
  it('puts an answer back into the Session the request came from, injected so it does not wake that Session\'s agent', async () => {
    const deliver = vi.fn(async () => 'sent' as const)
    const host = { commands: undefined as never, deliver }
    const sent = await chatKind.channel!.send(host, { id: 'reply-1', kind: 'reply', text: 'done',
      channel: { source: CHAT_SOURCE, thread: 'person-1', address: { session: 'person-1' } } })
    expect(sent).toBe('sent')
    expect(deliver).toHaveBeenCalledWith('person-1', 'reply-1', 'done', { inject: 'super-agent reply' })
    // A receipt without the Session in its address can never be delivered.
    expect(await chatKind.channel!.send(host, { id: 'reply-2', kind: 'reply', text: 'done',
      channel: { source: CHAT_SOURCE, thread: 'person-1', address: {} } })).toBe('gone')
  })
  it('is explicit for the operator the Policy lists, and ignored for a Source the Policy does not list', () => {
    const listed = SettingsSchema.parse({ policy: { sources: { chat: CHAT_POLICY } } })
    const registry = new SourceRegistry(() => listed)
    registry.register(chatKind)
    const trigger = chatTrigger('person-1', { id: 'm1', text: 'fix the login bug', at: '' })
    expect(registry.scope(trigger)).toEqual({ listened: true, observed: false })
    expect(settingsPolicy(listed, registry).gate(trigger, thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { via: 'addressed' } })
    const unlisted = SettingsSchema.parse({})
    const bare = new SourceRegistry(() => unlisted)
    bare.register(chatKind)
    expect(settingsPolicy(unlisted, bare).gate(trigger, thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
  })
})

const thread = () => ({ key: 'chat:person-1', ref: { source: CHAT_SOURCE, id: 'person-1' }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} })

describe('chat intake', () => {
  let host: Host
  afterEach(async () => { await host?.stop() })
  /** The Source as its plugin wires it: registered, with its Policy section, listening to every Session's events. */
  async function listen(): Promise<Host> {
    host = await startRuntime()
    host.runtime.sources.register(chatKind)
    await host.runtime.ensurePolicy(CHAT_SOURCE, CHAT_POLICY)
    const source = host.runtime.context(chatKind)
    source.report(CHAT_SOURCE, { state: 'ready', detail: 'Every Session is a channel' })
    host.ctx.on('session/event', (session: Session, event: { type: string }) => {
      if (!chatAccepts(source, session)) return
      const found = chatMessage(event as never)
      if (found) void source.receive(chatTrigger(session.id, found))
    }, true)
    return host
  }
  it('turns a message in a person\'s Session into a Trigger the Engine queues for assessment, and keeps it out of owned Sessions', async () => {
    const h = await listen()
    const personSession = session('person-1')
    h.ctx.emit('session/event', personSession as never, message(person('add a Usage section', 'm1')) as never)
    await h.runtime.idle()
    // The Trigger is stored on its Thread, and the main Session is told about it as a candidate.
    expect(h.runtime.store.triggers.get('chat:person-1:m1')).toMatchObject({ source: CHAT_SOURCE, human: true,
      channel: { address: { session: 'person-1' } } })
    expect(h.runtime.store.threads.get('chat:person-1')).toBeDefined()
    expect(h.candidates()).toContain('chat:person-1:m1')
    // A relay the plugin itself delivered, a subagent's prompt, and the orchestrator's own Session are not requests.
    h.ctx.emit('session/event', personSession as never, message(relay('candidate: add a Usage section', 'm2')) as never)
    h.ctx.emit('session/event', session('child-1', { origin: 'subagent' }) as never, message(person('child work', 'm3')) as never)
    h.ctx.emit('session/event', session(h.runtime.masterId) as never, message(person('router turn', 'm4')) as never)
    await h.runtime.idle()
    expect(h.runtime.store.triggers.get('chat:person-1:m2')).toBeUndefined()
    expect(h.runtime.store.triggers.get('chat:child-1:m3')).toBeUndefined()
    expect(h.runtime.store.triggers.get(`chat:${h.runtime.masterId}:m4`)).toBeUndefined()
  })
  it('records the Policy section once, so a Policy a person edited afterwards stays theirs', async () => {
    const h = await listen()
    const policy = h.runtime.store.settings().policy
    expect(policy.sources[CHAT_SOURCE]).toMatchObject({ allowed: [{ id: CHAT_ACTOR, name: '本机操作者' }] })
    const edited = { ...policy, sources: { ...policy.sources, [CHAT_SOURCE]: { ...policy.sources[CHAT_SOURCE]!, allowed: [] } } }
    h.runtime.store.saveSettings({ ...h.runtime.store.settings(), policy: edited })
    await h.runtime.ensurePolicy(CHAT_SOURCE, CHAT_POLICY)
    expect(h.runtime.store.settings().policy.sources[CHAT_SOURCE]).toMatchObject({ allowed: [] })
  })
  it('reports a Session that no longer exists as gone instead of failing the delivery', async () => {
    const h = await listen()
    expect(await h.runtime.sessions.deliver('no-such-session', 'reply-1', 'done', { inject: 'super-agent reply' })).toBe('gone')
  })
})

/** A Trigger whose Thread the Policy can judge. */
export type { Trigger }
