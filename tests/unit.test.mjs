// Unit tests: schema, repository helpers, auth cache, Hermes client.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendMessage,
  createTicket,
  finishTurn,
  getTicketRow,
  listAllTickets,
  listTicketsForUser,
  messagesFor,
  migrate,
  openDb,
  setTicketStatus,
  toAdminTicket,
  toApiTicket,
} from '../server/db.mjs'
import { createAuthCache, identityFromMe, isAdmin, tokenHash } from '../server/auth.mjs'
import { createHermesClient, shortReason, SYSTEM_PROMPT } from '../server/hermes.mjs'
import { createStubHermes, sleep } from './helpers.mjs'

function freshDb(tag) {
  const dir = mkdtempSync(join(tmpdir(), `lyra_desk_unit_${tag}_`))
  const db = openDb(join(dir, 'tickets.db'))
  migrate(db)
  return { dir, db, close: () => { try { db.close() } catch {} ; rmSync(dir, { recursive: true, force: true }) } }
}

test('schema: required columns and indexes exist', () => {
  const { db, close } = freshDb('schema')
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name)
    assert.ok(tables.includes('tickets'), 'tickets table')
    assert.ok(tables.includes('ticket_messages'), 'ticket_messages table')

    const cols = db.prepare('PRAGMA table_info(tickets)').all().map(r => r.name)
    assert.deepEqual(cols, ['id', 'user_id', 'title', 'status', 'lyra_session_id', 'created_at', 'updated_at'])
    const mcols = db.prepare('PRAGMA table_info(ticket_messages)').all().map(r => r.name)
    assert.deepEqual(mcols, ['id', 'ticket_id', 'role', 'content', 'created_at', 'tokens'])

    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name)
    assert.ok(idx.includes('idx_tm_ticket'))
    // idempotent
    migrate(db)
    assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 0)
  } finally { close() }
})

test('repo: create/list/append/status round-trip with ordering', () => {
  const { db, close } = freshDb('repo')
  try {
    const a = createTicket(db, { userId: 7, title: 'A', body: '第一条', now: 1000 })
    assert.equal(a.userMessage.role, 'user')
    assert.equal(a.userMessage.ticket_id, a.ticketId)

    const b = createTicket(db, { userId: 7, title: 'B', body: '另一条', now: 2000 })
    appendMessage(db, { ticketId: b.ticketId, role: 'assistant', content: '答', now: 2001, tokens: 9 })
    const rowB = getTicketRow(db, b.ticketId)
    assert.equal(rowB.updated_at, 2001)

    const list = listTicketsForUser(db, 7)
    assert.equal(list.length, 2)
    assert.equal(list[0].title, 'B', 'updated_at DESC')
    assert.equal(list[0].message_count, 2)
    assert.equal(list[0].last_message, '答')

    // another user sees none of it
    assert.equal(listTicketsForUser(db, 8).length, 0)
    assert.equal(listAllTickets(db).length, 2)
    assert.equal(toAdminTicket(list[0]).userId, 7)

    finishTurn(db, { ticketId: a.ticketId, sessionId: 'sess-1', status: 'answered', now: 1500 })
    const rowA = getTicketRow(db, a.ticketId)
    assert.equal(rowA.lyra_session_id, 'sess-1')
    assert.equal(rowA.status, 'answered')

    // a later failed turn must not wipe the session binding
    finishTurn(db, { ticketId: a.ticketId, sessionId: '', status: 'open', now: 1600 })
    assert.equal(getTicketRow(db, a.ticketId).lyra_session_id, 'sess-1')
    assert.equal(getTicketRow(db, a.ticketId).status, 'open')

    setTicketStatus(db, a.ticketId, 'closed', 1700)
    assert.equal(getTicketRow(db, a.ticketId).status, 'closed')

    const msgs = messagesFor(db, a.ticketId)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].content, '第一条')
  } finally { close() }
})

test('toApiTicket clips long last messages and hides session id', () => {
  const messages = [{ id: 2, role: 'assistant', content: 'x'.repeat(500), created_at: 1, tokens: 0 }]
  const out = toApiTicket({
    id: 1, user_id: 3, title: 'T', status: 'answered', created_at: 1, updated_at: 2,
    lyra_session_id: 'secret-session',
  }, messages)
  assert.equal(out.id, 1)
  assert.equal(out.messageCount, 1)
  assert.ok(out.lastMessage.length <= 161)
  assert.ok(out.lastMessage.endsWith('…'))
  assert.equal(out.user_id, undefined)
  assert.equal(out.lyra_session_id, undefined)
  assert.equal(out.messages.length, 1)
})

test('auth: identity extraction and role split', () => {
  assert.equal(identityFromMe({}), null)
  assert.equal(identityFromMe({ user: { id: 'x' } }), null)
  assert.equal(identityFromMe({ user: { id: 0 } }), null)
  assert.deepEqual(identityFromMe({ user: { id: 5, role: 'admin' } }), {
    userId: 5, role: 'admin', user: { id: 5, role: 'admin' },
  })
  assert.equal(isAdmin({ role: 'super_admin' }), true)
  assert.equal(isAdmin({ role: 'admin' }), true)
  assert.equal(isAdmin({ role: 'user' }), false)
  assert.equal(isAdmin(null), false)
})

test('auth cache: 60s positive TTL, 5s negative TTL, keyed by sha256', async () => {
  let clock = 10_000
  let calls = 0
  const verify = async token => {
    calls++
    return token === 'good' ? { userId: 1, role: 'user' } : null
  }
  const cache = createAuthCache(verify, () => clock)

  assert.deepEqual(await cache.verify('good'), { userId: 1, role: 'user' })
  assert.deepEqual(await cache.verify('good'), { userId: 1, role: 'user' })
  assert.equal(calls, 1, 'second hit served from cache')

  clock += 59_999
  await cache.verify('good')
  assert.equal(calls, 1, 'still inside 60s')
  clock += 2
  await cache.verify('good')
  assert.equal(calls, 2, 'expired after 60s')

  assert.equal(await cache.verify('bad'), null)
  clock += 4_000
  assert.equal(await cache.verify('bad'), null)
  const before = calls
  clock += 2_000
  await cache.verify('bad')
  assert.equal(calls, before + 1, 'negative entry expires after 5s')

  // distinct tokens hash to distinct cache keys
  assert.notEqual(tokenHash('a'), tokenHash('b'))
  assert.equal(tokenHash('a').length, 64)

  // empty token never touches the verifier
  const beforeEmpty = calls
  assert.equal(await cache.verify(''), null)
  assert.equal(calls, beforeEmpty)
})

test('hermes: system prompt is first message and history is preserved', async () => {
  const stub = createStubHermes()
  const client = createHermesClient({ apiKey: 'test-key', fetchImpl: stub.fetchImpl })
  const r = await client.answer({
    history: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
      { role: 'user', content: '追问' },
    ],
  })
  assert.equal(r.ok, true)
  const sent = stub.calls[0].messages
  assert.equal(sent[0].role, 'system')
  assert.equal(sent[0].content, SYSTEM_PROMPT)
  assert.deepEqual(sent.slice(1).map(m => m.role), ['user', 'assistant', 'user'])
  assert.equal(r.tokens, 120)
  assert.match(r.sessionId, /^stub-/)
})

test('hermes: replays X-Hermes-Session-Id on the next turn', async () => {
  const stub = createStubHermes()
  const client = createHermesClient({ apiKey: 'test-key', fetchImpl: stub.fetchImpl })
  const first = await client.answer({ history: [{ role: 'user', content: '记住暗号：蓝鲸' }] })
  const second = await client.answer({
    history: [
      { role: 'user', content: '记住暗号：蓝鲸' },
      { role: 'assistant', content: first.content },
      { role: 'user', content: '回答' },
    ],
    sessionId: first.sessionId,
  })
  assert.equal(second.ok, true)
  assert.equal(stub.calls[1].sessionId, first.sessionId)
})

test('hermes: upstream errors become short reasons, never thrown', async () => {
  const stub = createStubHermes()
  const client = createHermesClient({ apiKey: 'test-key', fetchImpl: stub.fetchImpl })
  stub.setFailures(1)
  const r = await client.answer({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, '上游返回 500')

  const boom = createHermesClient({
    apiKey: 'k',
    fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError') },
  })
  const t = await boom.answer({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(t.ok, false)
  assert.equal(t.reason, '上游超时')

  const noKey = createHermesClient({ apiKey: '', fetchImpl: stub.fetchImpl })
  const k = await noKey.answer({ history: [{ role: 'user', content: 'hi' }] })
  assert.equal(k.ok, false)
  assert.equal(k.reason, '未配置上游密钥')

  assert.equal(shortReason({ status: 401 }), '上游鉴权失败')
  assert.equal(shortReason({ status: 429 }), '上游限流')
  assert.equal(shortReason({ status: 418 }), '上游返回 418')
  assert.equal(shortReason(new Error('x'.repeat(500))).length <= 121, true)
})

test('hermes: health probe is cached for 60s', async () => {
  const stub = createStubHermes()
  const client = createHermesClient({ apiKey: 'k', fetchImpl: stub.fetchImpl })
  assert.equal(await client.health(1_000), true)
  assert.equal(await client.health(30_000), true)
  assert.equal(stub.calls.length, 1, 'probe cached')
  assert.equal(await client.health(62_000), true)
  assert.equal(stub.calls.length, 2, 'probe refreshed after 60s')
})

test('openDb: busy_timeout and WAL configured', async () => {
  const { db, close } = freshDb('pragma')
  try {
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
    const mode = db.prepare('PRAGMA journal_mode').get().journal_mode
    assert.equal(String(mode).toLowerCase(), 'wal')
    await sleep(1)
  } finally { close() }
})
