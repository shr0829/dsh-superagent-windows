/**
 * Chat channel Source: a person's message in any DSH Session becomes a Trigger on a `chat:` Thread, and the Engine's
 * replies come back to that Session. This is the third channel the design's 4.2 asks for — a request starts in the
 * conversation where the person already is, not in a channel the agent had to be installed in.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { sourceContext } from './host.ts'
import type { SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const CHAT_SOURCE = 'chat'
/** The person at this machine: the only sender this Source has, and the one its Policy lists by default. */
export const CHAT_ACTOR = 'operator'
/** The Policy section written once, when the Source first appears, so a person's own request is an explicit one. */
export const CHAT_POLICY = { allowed: [{ id: CHAT_ACTOR, name: '本机操作者' }], admission: {} }
export const chatSchema = z.object({}).strict()
export type ChatConfig = z.infer<typeof chatSchema>

/** What a Session event contributes to a Trigger: the message id, its text, and when it was written. */
export interface ChatMessage { id: string; text: string; at: string }

/**
 * The message an event carries, when it is one a person wrote in this Session: a `user/message` the plugin did not deliver
 * itself, with text. Assistant messages, tool results, and the plugin's own relays and notices are none of them.
 */
export function chatMessage(event: SessionEvent, at = new Date().toISOString()): ChatMessage | undefined {
  if (event.type !== 'user/message') return undefined
  const message = event.data as { id?: unknown; role?: unknown; content?: unknown; source?: { kind?: unknown } }
  if (message.role !== 'user' || typeof message.id !== 'string' || !Array.isArray(message.content)) return undefined
  // The plugin's own relays and notices reach a Session as user messages; a person's messages come from DSH's user RPC.
  if (message.source?.kind !== 'user') return undefined
  const text = (message.content as { type?: unknown; text?: unknown }[])
    .filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n').trim()
  return text ? { id: message.id, text, at } : undefined
}

/**
 * The Trigger a person's message becomes: one Thread per Session (`chat:<session>`), the person as its actor, addressed
 * directly, and the Session as its Channel so an acknowledgement, an answer, and a result all land where it was written.
 * The id derives from the Session and the message, so re-reading a Session's history cannot ingest the same message twice.
 * `workspace` is the directory the Session runs in, which names the router that serves that workspace.
 */
export function chatTrigger(session: string, message: ChatMessage, workspace?: string): Trigger {
  return {
    id: `${CHAT_SOURCE}:${session}:${message.id}`,
    source: CHAT_SOURCE,
    threads: [{ source: CHAT_SOURCE, id: session }],
    actor: { source: CHAT_SOURCE, id: CHAT_ACTOR },
    human: true,
    addressed: 'direct',
    at: message.at,
    text: message.text,
    channel: { source: CHAT_SOURCE, thread: session, address: { session } },
    meta: { session, message: message.id, ...workspace ? { workspace } : {} },
  }
}

/**
 * Whether a message in `session` should become a Trigger: not while the Source is off, not in a Session the orchestrator
 * owns (its main Session and its workers take their messages from the Engine, not from a person typing), and not in a
 * subagent's own Session, whose prompts DSH writes as user messages too.
 */
export function chatAccepts(ctx: Pick<SourceContext, 'config' | 'owns'>, session: Pick<Session, 'id' | 'header'>): boolean {
  if (!ctx.config(CHAT_SOURCE) || ctx.owns(session.id)) return false
  const header = session.header as { origin?: string; parentSession?: unknown; delegationDepth?: number }
  return header.origin !== 'subagent' && header.parentSession === undefined && !header.delegationDepth
}

export const chatKind: SourceKind<ChatConfig> = {
  kind: CHAT_SOURCE,
  title: { zh: '会话', en: 'Sessions' },
  description: {
    zh: '在这个 DSH 的任意会话里说一句话，就是一次请求：它进入主 Session 的准入、被拆成工单、由执行器完成，结果回到同一个会话。',
    en: 'A message in any Session of this DSH is a request: it reaches the main Session\'s gate, becomes a Ticket, and the result comes back to the same conversation.',
  },
  schema: chatSchema,
  fields: [],
  health: [CHAT_SOURCE],
  // Every Trigger this Source makes is addressed to the agent by construction, so it observes nothing beyond them.
  scope: () => ({ listened: true, observed: false }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
    fields: [{ key: 'allowed', label: { zh: '可以下达请求的人', en: 'People who may originate work' }, type: 'rows',
      columns: [{ key: 'id', label: { zh: '标识', en: 'ID' }, type: 'text' }, { key: 'name', label: { zh: '名称', en: 'Name' }, type: 'text', optional: true }] }],
    explicit: {
      zh: '在会话里直接说出的请求；这条通道只有本机操作者，因此每句话都是直接请求。',
      en: 'A request written in a Session; the channel has only the local operator, so every message is a direct one.',
    },
  },
  channel: {
    // A reply goes back into the Session the request came from, injected without waking it: the person reads it where they
    // wrote, and the Session's own agent is not asked to answer a message the orchestrator wrote.
    async send(host, message) {
      const session = message.channel.address.session
      return session ? host.deliver(session, message.id, message.text, { inject: `super-agent ${message.kind}` }) : 'gone'
    },
    link: () => ({ url: '', label: { zh: '当前会话', en: 'This Session' } }),
  },
}

export const name = 'dsh-superagent-chat'
export const inject = ['orchestrator']

/** Registers the Source and turns every person's message in a Session it does not own into a Trigger. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(chatKind), 'chat: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, chatKind)
    // A person's own request has to be explicit, and an unlisted sender is ignored by default: list the operator once, and
    // never again, so a Policy a person edited afterwards stays theirs.
    void ctx.orchestrator.ensurePolicy(CHAT_SOURCE, CHAT_POLICY).catch(() => {})
    source.report(CHAT_SOURCE, { state: 'ready', detail: 'Every Session is a channel' })
    return ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (!chatAccepts(source, session)) return
      const message = chatMessage(event)
      if (!message) return
      // A failed intake is the Engine's to report through the trigger's disposition; it must not escape into DSH's process.
      void Promise.resolve(source.receive(chatTrigger(session.id, message, session.header.cwd))).catch(() => {})
    })
  }, 'chat: session listener')
}
