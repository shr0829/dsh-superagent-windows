/** `[fork]` A chat-only installation runs without a GitHub repository or account: the Session is the channel. */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { verifyEnvironment, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

vi.setConfig({ testTimeout: 30_000 })
let dir: string
/** A deployment resolved while the GitHub Source names no repository and no account. */
const chatOnly = () => ({ ...testMachine({ stateDir: dir }), repository: undefined, github: undefined })
/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess: SubprocessRuntime = {
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv({ GIT_CONFIG_GLOBAL: workerGitConfig(dir), GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
} as unknown as SubprocessRuntime
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chat-only-')); mkdirSync(join(dir, 'work')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('a deployment without a GitHub account', () => {
  it('writes a `gh` shim that says the installation has none, instead of one that runs a CLI', async () => {
    await writeEnvironment(chatOnly(), [])
    const gh = readFileSync(join(workerBin(dir), 'gh'), 'utf8')
    expect(gh).toContain('gh is unavailable: this installation has no GitHub account.')
    expect(gh).not.toContain('exec ')
  })

  it('gives the worker git no credential helper and no GitHub URL rewriting', async () => {
    await writeEnvironment(chatOnly(), [])
    const config = readFileSync(workerGitConfig(dir), 'utf8')
    expect(config).toContain('[user]\n\tuseConfigOnly = true')
    expect(config).not.toContain('[credential "https://github.com"]')
    expect(config).not.toContain('[url "https://github.com/"]')
  })

  it('blocks commands without offering `gh` as the account that acts for the agent', async () => {
    await writeEnvironment(chatOnly(), ['personal-gh'])
    const blocked = readFileSync(join(workerBin(dir), 'personal-gh'), 'utf8')
    expect(blocked).toContain('personal-gh is blocked in this installation.')
    expect(blocked).not.toContain('use gh')
  })

  it('verifies git without expecting a helper, and refuses a helper a leftover config still carries', async () => {
    const deployment = chatOnly()
    await writeEnvironment(deployment, [])
    const signal = new AbortController().signal
    await expect(verifyEnvironment(deployment, subprocess, signal)).resolves.toBeUndefined()
    // A worker config left over from an installation that had an account fails the check instead of passing silently.
    const withHelper = testDeployment({ stateDir: dir })
    await writeEnvironment(withHelper, [])
    await expect(verifyEnvironment(deployment, subprocess, signal)).rejects.toMatchObject({ problem: { code: 'gitTooOld' } })
  })

  it('names no repository and says so when a GitHub call needs an account', async () => {
    const local = new Commands(chatOnly, {}, new AbortController().signal)
    expect(local.repository).toBe('')
    await expect(local.gh(['api', 'user'])).rejects.toThrow('This installation has no GitHub account.')
  })
})
