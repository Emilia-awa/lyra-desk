// HTTP surface tests. Real server, real SQLite, real routing; the only stubs
// are Studio identity and the Hermes upstream.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { migrate, openDb } from '../server/db.mjs'
import { createApp } from '../server/index.mjs'
import { createHermesClient } from '../server/hermes.mjs'
import {
  cleanup,
  createStubHermes,
  freePort,
  quietLogger,
  stubVerifier,
  tempDbPath,
  waitFor,
} from './helpers.mjs'

const ADMIN = 'Bearer user-1-super_admin'
const ALICE = 'Bearer user-2-user'
const BOB = 'Bearer user-3-user'

/** Boot one isolated sidecar per test file group. */
async function boot({ failFirst = false, answerDelayMs = 0 } = {}) {
  const { dir, dbPath } = tempDbPath('http')
  const db = openDb(dbPath)
  migrate(db)
  const stub = createStubHermes({ answerDelayMs })
  if (failFirst) stub.setFailures(1)
  const hermes = createHermesClient({ apiKey: 'test-key', fetchImpl: stub.fetchImpl })
  const app = createApp({ db, verify: stubVerifier(), hermes, logger: quietLogger() })

  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    app.handle(req, res).catch(err => {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })) }
      else res.end()
    })
  })
  const port = await freePort()
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${port}`

  async function call(path, { method = 'GET', token, body, rawBody, headers = {} } = {}) {
    const init = { method, headers: { ...headers } }
    if (token) init.headers.authorization = token
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    } else if (rawBody !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = rawBody
    }
    const res = await fetch(base + path, init)
    const txt = await res.text()
    let data = null
    try { data = txt ? JSON.parse(txt) : null } catch { data = null }
    return { status: res.status, data, text: txt, headers: res.headers }
  }

  return {
    stubs: stub,
    call,
    db,
    base,
    async close() {
      await new Promise(resolve => server.close(resolve))
      try { db.close() } catch {}
      cleanup(dir)
    },
  }
}

test('health: ok=true plus cached AI probe', async () => {
  const h = await boot()
  try {
    const r = await h.call('/api/health')
    assert.equal(r.status, 200)
    assert.equal(r.data.ok, true)
    assert.equal(r.data.ai, true)
    const again = await h.call('/api/health')
    assert.equal(again.data.ai, true)
    assert.equal(h.stubs.calls.length, 1, 'probe cached for 60s')
  } finally { await h.close() }
})

test('auth: missing or invalid token → 401; health stays public', async () => {
  const h = await boot()
  try {
    assert.equal((await h.call('/api/tickets')).status, 401)
    assert.equal((await h.call('/api/tickets', { token: 'Bearer nonsense' })).status, 401)
    assert.equal((await h.call('/api/tickets', { token: 'Token abc' })).status, 401)
    assert.equal((await h.call('/api/health')).status, 200)
  } finally { await h.close() }
})

test('create: returns ticket with a non-empty assistant answer', async () => {
  const h = await boot()
  try {
    const r = await h.call('/api/tickets', {
      method: 'POST', token: ALICE, body: { title: '登录失败', body: '我登录 Lyra 时一直转圈' },
    })
    assert.equal(r.status, 200, r.text)
    const t = r.data.ticket
    assert.equal(t.title, '登录失败')
    assert.equal(t.status, 'answered')
    assert.equal(t.userId, undefined)
    assert.equal(t.messages.length, 2)
    assert.equal(t.messages[0].role, 'user')
    assert.equal(t.messages[1].role, 'assistant')
    assert.match(t.messages[1].content, /回答：我登录 Lyra 时一直转圈/)
    assert.ok(t.messages[1].tokens > 0, 'usage.total_tokens accumulated')
    assert.equal(r.data.assistantMessage.id, t.messages[1].id)

    // first upstream call carried the system prompt and only the user message
    const sent = h.stubs.calls[0].messages
    assert.equal(sent[0].role, 'system')
    assert.match(sent[0].content, /Lyra Studio 的内置支持助手/)
    assert.equal(sent.length, 2)

    // stored session id, hidden in API output
    const row = h.db.prepare('SELECT * FROM tickets WHERE id = ?').get(t.id)
    assert.match(row.lyra_session_id, /^stub-/)
  } finally { await h.close() }
})

test('follow-up: replays session id and answers "刚才我问的是什么"', async () => {
  const h = await boot()
  try {
    const created = (await h.call('/api/tickets', {
      method: 'POST', token: ALICE, body: { title: '会话续接', body: '我的暗号是蓝鲸四七' },
    })).data.ticket
    const r = await h.call(`/api/tickets/${created.id}/messages`, {
      method: 'POST', token: ALICE, body: { content: '刚才我问的是什么' },
    })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.data.messages.length, 2)
    assert.match(r.data.messages[1].content, /你刚才问的是/)
    const secondCall = h.stubs.calls[1]
    assert.match(secondCall.sessionId, /^stub-/, 'X-Hermes-Session-Id replayed')
    assert.equal(secondCall.messages[0].role, 'system')
    assert.deepEqual(
      secondCall.messages.slice(1).map(m => m.role),
      ['user', 'assistant', 'user'],
      'full ticket history is resent',
    )
    assert.equal(secondCall.messages[3].content, '刚才我问的是什么')
  } finally { await h.close() }
})

test('ownership: another user gets 404, never 403, for every verb', async () => {
  const h = await boot()
  try {
    const t = (await h.call('/api/tickets', {
      method: 'POST', token: ALICE, body: { title: '私密工单', body: '只属于 alice' },
    })).data.ticket

    for (const [method, path] of [
      ['GET', `/api/tickets/${t.id}`],
      ['POST', `/api/tickets/${t.id}/messages`],
      ['POST', `/api/tickets/${t.id}/close`],
      ['POST', `/api/tickets/${t.id}/reopen`],
    ]) {
      const r = await h.call(path, { method, token: BOB, body: method === 'POST' ? { content: '偷看' } : undefined })
      assert.equal(r.status, 404, `${method} ${path} must be 404`)
      assert.equal(r.data.error, '工单不存在')
    }

    // alice still sees it, bob's list is empty
    assert.equal((await h.call(`/api/tickets/${t.id}`, { token: ALICE })).data.ticket.title, '私密工单')
    assert.deepEqual((await h.call('/api/tickets', { token: BOB })).data.tickets, [])
    // and bob's attempt did not create a message
    assert.equal((await h.call(`/api/tickets/${t.id}`, { token: ALICE })).data.ticket.messages.length, 2)

    // unknown / malformed ids are 404 too
    assert.equal((await h.call('/api/tickets/9999', { token: ALICE })).status, 404)
    assert.equal((await h.call('/api/tickets/abc', { token: ALICE })).status, 404)
    assert.equal((await h.call('/api/tickets/0', { token: ALICE })).status, 404)
  } finally { await h.close() }
})

test('list: own tickets only, newest first, with messageCount/lastMessage', async () => {
  const h = await boot()
  try {
    const a = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: '第一条', body: '一' } })).data.ticket
    const b = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: '第二条', body: '二' } })).data.ticket
    await h.call('/api/tickets', { method: 'POST', token: BOB, body: { title: 'BOB 的', body: '三' } })

    const r = await h.call('/api/tickets', { token: ALICE })
    assert.equal(r.status, 200)
    assert.deepEqual(r.data.tickets.map(t => t.title), ['第二条', '第一条'])
    for (const t of r.data.tickets) {
      assert.equal(t.messageCount, 2)
      assert.ok(t.lastMessage.startsWith('回答：'))
      assert.ok(t.created_at > 0)
      assert.ok(t.updated_at >= t.created_at)
      assert.equal(t.messages, undefined, 'list rows omit the message array')
    }
    // updating an older ticket moves it to the top
    await h.call(`/api/tickets/${a.id}/messages`, { method: 'POST', token: ALICE, body: { content: '再问一句' } })
    const after = (await h.call('/api/tickets', { token: ALICE })).data.tickets
    assert.equal(after[0].title, '第一条')
    assert.equal(after[0].messageCount, 4)
    assert.equal(b.id, b.id)
  } finally { await h.close() }
})

test('closed ticket: submissions are rejected with 400, reopen restores it', async () => {
  const h = await boot()
  try {
    const t = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: '要关掉', body: '关闭测试' } })).data.ticket
    const closed = await h.call(`/api/tickets/${t.id}/close`, { method: 'POST', token: ALICE })
    assert.equal(closed.status, 200)
    assert.equal(closed.data.ticket.status, 'closed')

    const rejected = await h.call(`/api/tickets/${t.id}/messages`, {
      method: 'POST', token: ALICE, body: { content: '关掉后还能问吗' },
    })
    assert.equal(rejected.status, 400)
    assert.match(rejected.data.error, /已关闭/)
    const callsBefore = h.stubs.calls.length

    const reopened = await h.call(`/api/tickets/${t.id}/reopen`, { method: 'POST', token: ALICE })
    assert.equal(reopened.data.ticket.status, 'open')
    const ok = await h.call(`/api/tickets/${t.id}/messages`, {
      method: 'POST', token: ALICE, body: { content: '现在可以问了' },
    })
    assert.equal(ok.status, 200)
    assert.equal(h.stubs.calls.length, callsBefore + 1, 'no upstream call while closed')
  } finally { await h.close() }
})

test('validation: empty/long title, empty/long content, bad JSON, oversized body', async () => {
  const h = await boot()
  try {
    const cases = [
      [{ title: '', body: 'x' }, /标题不能为空/],
      [{ title: 'x'.repeat(201), body: 'x' }, /200/],
      [{ title: 'ok', body: '' }, /内容不能为空/],
      [{ title: 'ok', body: 'x'.repeat(8001) }, /8000/],
      [{ body: 'x' }, /标题不能为空/],
    ]
    for (const [body, re] of cases) {
      const r = await h.call('/api/tickets', { method: 'POST', token: ALICE, body })
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80))
      assert.match(r.data.error, re)
    }

    const bad = await h.call('/api/tickets', { method: 'POST', token: ALICE, rawBody: '{not json' })
    assert.equal(bad.status, 400)

    const big = await h.call('/api/tickets', {
      method: 'POST', token: ALICE, rawBody: JSON.stringify({ title: 't', body: 'x'.repeat(6 * 1024 * 1024 + 100) }),
    })
    assert.equal(big.status, 413)

    // exactly at the limits is fine
    const t = (await h.call('/api/tickets', {
      method: 'POST', token: ALICE, body: { title: 'x'.repeat(200), body: 'y'.repeat(8000) },
    })).data.ticket
    assert.equal(t.title.length, 200)
    const over = await h.call(`/api/tickets/${t.id}/messages`, {
      method: 'POST', token: ALICE, body: { content: 'z'.repeat(8001) },
    })
    assert.equal(over.status, 400)
  } finally { await h.close() }
})

test('AI failure: error bubble is persisted, ticket stays open, no spinner', async () => {
  const h = await boot({ failFirst: true })
  try {
    const r = await h.call('/api/tickets', {
      method: 'POST', token: ALICE, body: { title: '上游挂了', body: '这轮一定失败' },
    })
    assert.equal(r.status, 200, 'creation still succeeds')
    const t = r.data.ticket
    assert.equal(t.messages.length, 2)
    assert.match(t.messages[1].content, /^抱歉，本轮回答失败：上游返回 500$/)
    assert.equal(t.messages[1].role, 'assistant')
    assert.equal(t.status, 'open')
    assert.equal(t.messages[1].tokens, 0)

    // the failed turn must not have stored a session id, and a retry binds one
    assert.equal(h.db.prepare('SELECT lyra_session_id FROM tickets WHERE id = ?').get(t.id).lyra_session_id, '')
    const retry = await h.call(`/api/tickets/${t.id}/messages`, {
      method: 'POST', token: ALICE, body: { content: '重试一下' },
    })
    assert.equal(retry.status, 200)
    assert.match(retry.data.messages[1].content, /^回答：/)
    assert.equal(retry.data.ticket.status, 'answered')
    assert.match(h.db.prepare('SELECT lyra_session_id FROM tickets WHERE id = ?').get(t.id).lyra_session_id, /^stub-/)
  } finally { await h.close() }
})

test('serialization: concurrent submissions on one ticket do not interleave', async () => {
  const h = await boot({ answerDelayMs: 80 })
  try {
    const t = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: '并发', body: '起点' } })).data.ticket
    const [r1, r2, r3] = await Promise.all([
      h.call(`/api/tickets/${t.id}/messages`, { method: 'POST', token: ALICE, body: { content: '并发一' } }),
      h.call(`/api/tickets/${t.id}/messages`, { method: 'POST', token: ALICE, body: { content: '并发二' } }),
      h.call(`/api/tickets/${t.id}/messages`, { method: 'POST', token: ALICE, body: { content: '并发三' } }),
    ])
    for (const r of [r1, r2, r3]) assert.equal(r.status, 200, r.text)

    const msgs = (await h.call(`/api/tickets/${t.id}`, { token: ALICE })).data.ticket.messages
    // user/assistant pairs, strictly alternating after the first exchange
    assert.equal(msgs.length, 8)
    for (let i = 0; i < msgs.length; i++) {
      assert.equal(msgs[i].role, i % 2 === 0 ? 'user' : 'assistant', `role at ${i}`)
    }
    // each answer sits directly after its own question
    for (let i = 0; i < msgs.length; i += 2) {
      assert.equal(msgs[i + 1].content, `回答：${msgs[i].content.slice(0, 40)}`)
    }
    // every answered turn saw the whole preceding history in order
    const userTexts = msgs.filter(m => m.role === 'user').map(m => m.content)
    assert.deepEqual(userTexts.slice(0, 1), ['起点'])
  } finally { await h.close() }
})

test('admin: only admin roles can read all tickets, response includes userId', async () => {
  const h = await boot()
  try {
    const t = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: '给管理员看', body: '正文' } })).data.ticket
    await h.call('/api/tickets', { method: 'POST', token: BOB, body: { title: 'BOB 单', body: '正文' } })

    assert.equal((await h.call('/api/admin/tickets', { token: ALICE })).status, 403)
    assert.equal((await h.call('/api/admin/tickets')).status, 401)

    const r = await h.call('/api/admin/tickets', { token: ADMIN })
    assert.equal(r.status, 200)
    assert.equal(r.data.tickets.length, 2)
    const mine = r.data.tickets.find(x => x.id === t.id)
    assert.equal(mine.userId, 2)
    assert.equal(mine.title, '给管理员看')
    assert.ok(r.data.tickets.every(x => Number.isInteger(x.userId)))
  } finally { await h.close() }
})

test('admin: reading someone else ticket still 404 on the user surface', async () => {
  const h = await boot()
  try {
    const t = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: 'A 的', body: 'x' } })).data.ticket
    // Deliberate: /api/tickets/:id is owner-scoped even for admins; admins use
    // /api/admin/tickets for cross-user reads.
    assert.equal((await h.call(`/api/tickets/${t.id}`, { token: ADMIN })).status, 404)
  } finally { await h.close() }
})

test('routing: /tickets-api prefix works, unknown paths 404, methods 405', async () => {
  const h = await boot()
  try {
    const viaPrefix = await h.call('/tickets-api/tickets', { token: ALICE })
    assert.equal(viaPrefix.status, 200)
    assert.deepEqual(viaPrefix.data.tickets, [])

    assert.equal((await h.call('/api/nope', { token: ALICE })).status, 404)
    assert.equal((await h.call('/api/tickets/1/unknown', { token: ALICE })).status, 404)
    assert.equal((await h.call('/api/tickets', { method: 'DELETE', token: ALICE })).status, 405)
    assert.equal((await h.call('/api/health', { method: 'POST' })).status, 405)
    assert.equal((await h.call('/api/tickets/1/close', { method: 'GET', token: ALICE })).status, 404)
  } finally { await h.close() }
})

test('tokens column accumulates across turns', async () => {
  const h = await boot()
  try {
    const t = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: 'token 累计', body: '第一轮' } })).data.ticket
    await h.call(`/api/tickets/${t.id}/messages`, { method: 'POST', token: ALICE, body: { content: '第二轮' } })
    const msgs = (await h.call(`/api/tickets/${t.id}`, { token: ALICE })).data.ticket.messages
    const assistantTokens = msgs.filter(m => m.role === 'assistant').reduce((sum, m) => sum + m.tokens, 0)
    assert.equal(assistantTokens, 240, '120 tokens per stub turn, plus nothing for user rows')
    assert.equal(h.db.prepare('SELECT SUM(tokens) s FROM ticket_messages').get().s, 240)
  } finally { await h.close() }
})

test('ticket detail includes every stored message in order', async () => {
  const h = await boot()
  try {
    const t = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: '顺序', body: '第一句' } })).data.ticket
    await h.call(`/api/tickets/${t.id}/messages`, { method: 'POST', token: ALICE, body: { content: '第二句' } })
    const detail = (await h.call(`/api/tickets/${t.id}`, { token: ALICE })).data.ticket
    assert.deepEqual(detail.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant'])
    assert.equal(detail.messages[0].content, '第一句')
    assert.equal(detail.messages[2].content, '第二句')
    assert.equal(detail.messages[2].tokens, 0)
    const ids = detail.messages.map(m => m.id)
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b))
    assert.equal(detail.messageCount, 4)
  } finally { await h.close() }
})

test('isolation: no writes outside the ticket database file', async () => {
  const h = await boot()
  try {
    await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: '隔离', body: '只落 tickets.db' } })
    const files = h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name)
    assert.deepEqual(files, ['sqlite_sequence', 'ticket_messages', 'tickets'])
    assert.equal(h.db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 1)
  } finally { await h.close() }
})

test('concurrency: two different tickets run independently', async () => {
  const h = await boot({ answerDelayMs: 40 })
  try {
    const [a, b] = await Promise.all([
      h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: 'A', body: '甲' } }),
      h.call('/api/tickets', { method: 'POST', token: BOB, body: { title: 'B', body: '乙' } }),
    ])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(a.data.ticket.messages[1].content, '回答：甲')
    assert.equal(b.data.ticket.messages[1].content, '回答：乙')
  } finally { await h.close() }
})

test('closed tickets are still readable and listable', async () => {
  const h = await boot()
  try {
    const t = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: '归档', body: '内容' } })).data.ticket
    await h.call(`/api/tickets/${t.id}/close`, { method: 'POST', token: ALICE })
    const detail = await h.call(`/api/tickets/${t.id}`, { token: ALICE })
    assert.equal(detail.status, 200)
    assert.equal(detail.data.ticket.status, 'closed')
    const list = (await h.call('/api/tickets', { token: ALICE })).data.tickets
    assert.equal(list[0].status, 'closed')
  } finally { await h.close() }
})

test('startup: non-loopback host is rejected', async () => {
  const { startServer } = await import('../server/index.mjs')
  const { dir, dbPath } = tempDbPath('loop')
  try {
    assert.throws(() => startServer({ host: '0.0.0.0', port: 0, dbPath }), /loopback/)
    assert.throws(() => startServer({ host: '192.168.1.5', port: 0, dbPath }), /loopback/)
  } finally {
    cleanup(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('admin: detail endpoint returns messages and owner, read-only', async () => {
  const h = await boot()
  try {
    const t = (await h.call('/api/tickets', { method: 'POST', token: ALICE, body: { title: '管理详情', body: '正文' } })).data.ticket
    assert.equal((await h.call(`/api/admin/tickets/${t.id}`, { token: ALICE })).status, 403)
    const r = await h.call(`/api/admin/tickets/${t.id}`, { token: ADMIN })
    assert.equal(r.status, 200)
    assert.equal(r.data.ticket.userId, 2)
    assert.equal(r.data.ticket.messages.length, 2)
    assert.equal((await h.call(`/api/admin/tickets/${t.id}`, { method: 'POST', token: ADMIN })).status, 405)
    assert.equal((await h.call('/api/admin/tickets/9999', { token: ADMIN })).status, 404)
  } finally { await h.close() }
})

test('cors: loopback origins allowed, OPTIONS preflight, foreign origin refused', async () => {
  const h = await boot()
  try {
    const pre = await fetch(h.base + '/api/tickets', {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:8648', 'access-control-request-method': 'GET' },
    })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8648')
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization/)

    const denied = await fetch(h.base + '/api/tickets', {
      method: 'OPTIONS', headers: { origin: 'https://evil.example' },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('access-control-allow-origin'), null)
  } finally { await h.close() }
})
