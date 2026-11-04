// Shared helpers for the Lyra Desk test suite.
//
// Every test works on a throwaway database directory and a stub upstream. The
// production database (/root/work/lyra_desk/data/tickets.db) is never opened
// by the tests.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tempDbPath(tag = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'lyra_desk_test_'))
  return { dir, dbPath: join(dir, `tickets_${tag}.db`) }
}

export function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/** Reserve an ephemeral TCP port, then free it for the caller to bind. */
export async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** Wait until `fn()` is truthy, or throw after `timeoutMs`. */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await sleep(intervalMs)
  }
}

/** Silent logger so test output stays about assertions, not request lines. */
export function quietLogger() {
  const noop = () => {}
  return { info: noop, warn: noop, error: noop, log: noop }
}

/**
 * A stub identity provider: token `user-<id>-<role>` maps to that user.
 * Anything else is rejected, which mirrors Studio's 401.
 */
export function stubVerifier() {
  const calls = []
  const fn = async token => {
    calls.push(token)
    const m = /^user-(\d+)-([a-z_]+)$/.exec(String(token))
    if (!m) return null
    return { userId: Number(m[1]), role: m[2], user: { id: Number(m[1]), role: m[2] } }
  }
  fn.calls = calls
  return fn
}

/**
 * A stub Hermes upstream implementing the two behaviours the sidecar relies
 * on: `X-Hermes-Session-Id` echo/persistence, and an OpenAI-shaped body.
 *
 * The fake keeps one in-memory conversation per session id, so a test can prove
 * that replaying the header actually carries previous turns (the sidecar sends
 * history too — this fake deliberately answers from session memory only, so a
 * missing header would be visible as a lost follow-up).
 */
export function createStubHermes({ answerDelayMs = 0, failNext = 0, sessions = new Map() } = {}) {
  let nextSession = 0
  let failuresLeft = failNext
  const calls = []

  const answer = ({ messages, sessionId }) => {
    const sid = sessionId || `stub-${++nextSession}`
    const history = sessions.get(sid) || []
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    calls.push({ sessionId, sid, messages: JSON.parse(JSON.stringify(messages)) })

    if (/刚才我问的是什么/.test(lastUser ? lastUser.content : '')) {
      return `你刚才问的是：${history.length ? history[history.length - 1] : '（没有记录）'}`
    }
    if (/失败/.test(lastUser ? lastUser.content : '')) {
      throw Object.assign(new Error('stub upstream exploded'), { status: 500 })
    }
    const reply = `回答：${lastUser ? lastUser.content.slice(0, 40) : '（空）'}`
    sessions.set(sid, [...history, lastUser ? lastUser.content : '', reply])
    return reply
  }

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const sessionId = init.headers['x-hermes-session-id'] || ''
    if (answerDelayMs) await sleep(answerDelayMs)
    if (failuresLeft > 0) {
      failuresLeft--
      return new Response(JSON.stringify({ error: 'stub failure' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
    let content
    try {
      content = answer({ messages: body.messages, sessionId })
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status || 500,
        headers: { 'content-type': 'application/json' },
      })
    }
    const sid = calls[calls.length - 1].sid
    return new Response(JSON.stringify({
      id: 'stub',
      object: 'chat.completion',
      model: 'hermes-agent',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-hermes-session-id': sid,
      },
    })
  }

  return {
    fetchImpl,
    calls,
    sessions,
    get failCount() { return failuresLeft },
    setFailures(n) { failuresLeft = n },
  }
}
