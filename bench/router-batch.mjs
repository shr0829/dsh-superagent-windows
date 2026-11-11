#!/usr/bin/env node
/**
 * Router batch measurement: how many Intake Triggers one Eval — one assessor request, one main-Session LLM call — covers
 * at the real `Intake.receive` → `Engine.evaluateDue` → `Evals.start` → `Assessor.request` path (src/core/intake.ts,
 * src/core/engine.ts:75-85, src/core/evals.ts:71-119). Fully offline and deterministic: no network, no timers, no LLM.
 *
 * What it measures: assessment (Eval) call counts, batch sizes, and calls per Trigger, against the naive baseline of one
 * call per Trigger. What it does not measure: the wall-clock gain of a shared prefill, which depends on the model and the
 * network — see the `note` field of the JSON this writes.
 *
 * Usage: node bench/router-batch.mjs [--triggers N] [--threads B] [--per-thread A] [--rounds R]
 *                                    [--mode drain|hold|serial] [--hold K] [--out PATH]
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const NOTE = '这是调用次数与批大小的度量；prefill 的墙钟收益依赖具体模型与网络，本脚手架不测'

// The engine sources are TypeScript with constructor parameter properties, which `node` refuses to strip in place.
if (!process.execArgv.includes('--experimental-transform-types')) {
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', SELF, ...process.argv.slice(2)],
    { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const mode = arg('mode', 'all')
if (!['all', 'drain', 'hold', 'serial'].includes(mode)) throw new Error(`--mode must be all, drain, hold or serial, not ${mode}`)
const threads = Number(arg('threads', 12))
const perThread = Number(arg('per-thread', 3))
const triggersWanted = arg('triggers', undefined)
const rounds = Number(arg('rounds', triggersWanted === undefined ? 20 : Math.ceil(Number(triggersWanted) / (threads * perThread))))
const hold = Number(arg('hold', 4))
const out = resolve(HERE, arg('out', '../.artifacts/bench-router-batch.json'))

const { Engine, MemoryRepositories, threadKey } = await import(new URL('../src/core/index.ts', import.meta.url).href)

/** One scenario run against a fresh Engine, driven by the same call a pass makes (src/app/passes.ts:63-68 `pumpOnce`). */
function run({ key, label, threads: threadCount, perThread: arrivals, rounds: roundCount, holdRounds, serial }) {
  const repo = new MemoryRepositories()
  /** Every assessor request, in order: one per Eval, so one per main-Session LLM call. */
  const requests = []
  /** Evals still in progress: what a Trigger arriving meanwhile queues behind (src/core/part.ts:57-63). */
  let inFlight = []
  const outbox = new Set()
  let clock = 0
  const startedAt = Date.UTC(2026, 10, 11, 0, 0, 0)
  const now = () => new Date(startedAt + clock * 1000).toISOString()
  const engine = new Engine({
    repo,
    scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => ({ version: 'bench', paused: false, evalTimeoutMs: 3_600_000,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
      revalidate: () => true, admitsInferred: () => true }),
    assessor: { request: candidate => { requests.push(candidate); inFlight.push(candidate) } },
    executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: message => outbox.add(message.id), status: id => outbox.has(id) ? 'pending' : undefined, withdraw: id => outbox.delete(id) },
    now,
  })
  const refs = Array.from({ length: threadCount }, (_, index) => ({ source: 'chat', id: `b${index}` }))
  let sent = 0
  const deliver = (ref, count) => {
    for (let n = 0; n < count; n++) {
      const id = String(++sent).padStart(4, '0')
      engine.receive({ id, source: 'chat', threads: [ref], actor: { source: 'chat', id: 'alice' }, human: true, at: now(),
        text: `message ${id}`, channel: { source: 'chat', thread: threadKey(ref), address: { message: id } }, meta: {} })
    }
  }
  /** One pass: the pump's `engine.evaluateDue()` and nothing else (the bench has no effects to kick). */
  const pass = () => { clock += 2; engine.evaluateDue() }
  /** End every Eval in progress, as the assessor answering each one would; returns how many it ended. */
  const finishInFlight = () => {
    const ended = inFlight
    inFlight = []
    for (const candidate of ended) engine.decide(candidate.triggers[0].id, { kind: 'ignore', reason: 'chatter', evalId: candidate.evalId })
    return ended.length
  }
  const elapsed = process.hrtime.bigint()
  for (let round = 1; round <= roundCount; round++) {
    for (const ref of refs) {
      // serial: the pass passes.receive triggers after every single message (src/app/passes.ts:34-39).
      if (serial) for (let n = 0; n < arrivals; n++) { deliver(ref, 1); pass(); finishInFlight() }
      else deliver(ref, arrivals)
    }
    if (serial) continue
    pass()
    // hold: an Eval stays in progress for `holdRounds` rounds, so its Thread's Triggers pile up behind it.
    if (round % holdRounds === 0) finishInFlight()
  }
  // Drain what is left, so every Trigger is accounted for exactly once, whatever the mode held back.
  for (let guard = 0; guard < 100_000; guard++) {
    const pending = repo.threads.active().some(thread => thread.pending.length > 0)
    if (!pending && !inFlight.length) break
    if (pending && !inFlight.length) { pass(); continue }
    finishInFlight()
  }
  const elapsedMs = Number(process.hrtime.bigint() - elapsed) / 1e6

  const batchSizes = requests.map(candidate => candidate.triggers.length)
  const covered = requests.flatMap(candidate => candidate.triggers.map(trigger => trigger.id))
  const unique = new Set(covered)
  const decisions = repo.threads.list().reduce((sum, thread) => sum + repo.decisions.byThread(thread.key).length, 0)
  const leftover = repo.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating)
  return {
    key,
    scenario: label,
    config: { threads: threadCount, perThread: arrivals, rounds: roundCount, holdRounds, serial },
    triggers: sent,
    evals: requests.length,
    avgBatch: requests.length ? covered.length / requests.length : 0,
    maxBatch: batchSizes.length ? Math.max(...batchSizes) : 0,
    callsPerTrigger: sent ? requests.length / sent : 0,
    naiveCalls: sent,
    /** Calls the naive one-call-per-Trigger path makes, over the calls this path makes: the value of batching. */
    dilution: requests.length ? sent / requests.length : 0,
    decisions,
    triggersPerEval: Object.fromEntries([...new Set(batchSizes)].sort().map(size => [size, batchSizes.filter(item => item === size).length])),
    evalsPerThread: threadCount ? requests.length / threadCount : 0,
    checks: { everyTriggerInExactlyOneEval: unique.size === sent && covered.length === sent, leftoverThreads: leftover.length },
    elapsedMs: Math.round(elapsedMs * 10) / 10,
  }
}

const scenarios = [
  run({ key: 'drain', label: 'drain: one pass per round, and every Eval ends within its own round',
    threads, perThread, rounds, holdRounds: 1, serial: false }),
  run({ key: 'hold', label: `hold: an Eval stays in progress for ${hold} rounds, so its Thread's Triggers pile up behind it`,
    threads, perThread, rounds, holdRounds: hold, serial: false }),
  run({ key: 'serial', label: 'serial: a pass right after every arrival, as passes.receive does for one message',
    threads, perThread, rounds, holdRounds: 1, serial: true }),
].filter(scenario => mode === 'all' || mode === scenario.key)
const broken = scenarios.filter(scenario => !scenario.checks.everyTriggerInExactlyOneEval || scenario.checks.leftoverThreads > 0)

const report = { generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`,
  note: NOTE,
  codePath: ['src/core/intake.ts receive', 'src/core/engine.ts:75-85 evaluateDue (one Evals.start per Thread per pass)',
    'src/core/evals.ts:71-119 start (thread.pending becomes one Eval)', 'src/core/evals.ts:118 assessor.request (one LLM call)'],
  batchBoundary: 'Thread + the pending queue as a pass finds it; no time window, and no merge across Threads',
  scenarios }

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

const pad = (value, width) => String(value).padEnd(width)
console.log(`router batch bench — node ${process.version}, ${report.platform}`)
console.log(NOTE)
console.log('')
console.log(`${pad('scenario', 12)}${pad('triggers', 10)}${pad('evals', 8)}${pad('avgBatch', 10)}${pad('maxBatch', 10)}${pad('calls/trig', 12)}${pad('dilution', 10)}ms`)
for (const scenario of scenarios) {
  console.log(`${pad(scenario.scenario.split(':')[0], 12)}${pad(scenario.triggers, 10)}${pad(scenario.evals, 8)}` +
    `${pad(scenario.avgBatch.toFixed(2), 10)}${pad(scenario.maxBatch, 10)}${pad(scenario.callsPerTrigger.toFixed(4), 12)}` +
    `${pad(`${scenario.dilution.toFixed(2)}x`, 10)}${scenario.elapsedMs}`)
}
console.log('')
for (const scenario of scenarios) {
  console.log(`${scenario.scenario}`)
  console.log(`  batch sizes (triggers per Eval → Count): ${JSON.stringify(scenario.triggersPerEval)}`)
  console.log(`  Evals per Thread: ${scenario.evalsPerThread}, naive calls: ${scenario.naiveCalls}, dilution ${scenario.dilution.toFixed(2)}x`)
  console.log(`  checks: ${JSON.stringify(scenario.checks)}`)
}
console.log('')
console.log(`JSON: ${out}`)
if (broken.length) {
  console.error(`bench invariant broken: ${broken.map(scenario => scenario.scenario).join('; ')}`)
  process.exit(1)
}
