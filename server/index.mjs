#!/usr/bin/env node
// Lyra Desk ticket sidecar.
//
// One process, one SQLite file, one upstream: the `lyra-desk` Hermes profile on
// 127.0.0.1:8643. Studio owns identity, so the only auth check we perform is
// "ask Studio who this token belongs to" (GET /api/auth/me).
//
//   node server/index.mjs        → 127.0.0.1:8653
//
// Loopback binding is enforced: a wider LD_HOST is a configuration error, not a
// feature. Every SQL statement is parameter-bound. Nothing logs secrets.
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_STUDIO_BASE,
  bearerToken,
  createAuthCache,
  isAdmin,
  verifyAgainstStudio,
} from './auth.mjs'
import {
  DEFAULT_DB_PATH,
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
} from './db.mjs'
import { createHermesClient } from './hermes.mjs'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8653

const MAX_BODY_BYTES = 6 * 1024 * 1024
const MAX_TITLE_CHARS = 200
const MAX_CONTENT_CHARS = 8_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

const STATUS_OPEN = 'open'
const STATUS_ANSWERED = 'answered'
const STATUS_CLOSED = 'closed'

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

function text(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = err => {
      if (done) return
      done = true
      reject(err)
    }
    req.on('data', chunk => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        // Stop buffering immediately. Node closes the socket after the 413 is
        // written, so an oversized upload can never be processed.
        fail(Object.assign(new Error('body too large'), { statusCode: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }))
      }
    })
    req.on('error', fail)
  })
}

function str(v) { return typeof v === 'string' ? v : '' }

function chars(s) { return Array.from(s).length }

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host)
}

/** Parse a positive integer id, or null. */
function parseId(raw) {
  return /^[1-9]\d{0,18}$/.test(String(raw || '')) ? Number(raw) : null
}

/** Loopback origins only: the drawer may talk to :8653 directly when Studio
 *  is opened at 127.0.0.1:8648 without the nginx /tickets-api rewrite. */
function isLoopbackOrigin(origin) {
  if (!origin) return false
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && isLoopbackHost(u.hostname)
  } catch { return false }
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (!isLoopbackOrigin(origin)) return false
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
  res.setHeader('access-control-max-age', '600')
  res.setHeader('vary', 'Origin')
  return true
}

/**
 * Build the app. Everything is injectable so tests can run against a temp
 * database, a stub identity provider and a stub Hermes endpoint while
 * exercising the real HTTP surface.
 */
export function createApp({
  db,
  verify = verifyAgainstStudio,
  hermes = createHermesClient(),
  now = Date.now,
  logger = console,
} = {}) {
  if (!db) throw new Error('createApp requires a db')
  const auth = createAuthCache(verify, now)

  // Per-ticket promise chain: two concurrent POSTs on the same ticket run one
  // after another, so their AI answers cannot interleave in the message table.
  const chains = new Map()

  function serialize(ticketId, fn) {
    const prev = chains.get(ticketId) || Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    chains.set(ticketId, tail)
    tail.finally(() => {
      if (chains.get(ticketId) === tail) chains.delete(ticketId)
    })
    return run
  }

  async function authenticate(req) {
    const token = bearerToken(req)
    if (!token) return null
    const identity = await auth.verify(token)
    return identity ? { userId: identity.userId, role: identity.role } : null
  }

  /** Load a ticket owned by `userId`, or null (404 semantics: no existence leak). */
  function ownedTicket(ticketId, userId) {
    const row = getTicketRow(db, ticketId)
    if (!row || row.user_id !== userId) return null
    return row
  }

  function detailFor(ticketId) {
    const row = getTicketRow(db, ticketId)
    return toApiTicket(row, messagesFor(db, ticketId))
  }

  /**
   * Produce one assistant reply for a ticket that already has the new user
   * message stored. The caller must already hold the ticket lock.
   *
   * Returns the stored assistant message, or null when the turn crashed so
   * badly that nothing could be written. AI failures are persisted as an
   * assistant message, never as an HTTP error: the UI must always get an
   * answer bubble instead of a spinner.
   */
  async function answerTurn(ticketId) {
    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(STATUS_OPEN, ticketId)

    const history = messagesFor(db, ticketId)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }))

    const ticketRow = getTicketRow(db, ticketId)
    const reply = await hermes.answer({
      history,
      sessionId: ticketRow.lyra_session_id || '',
    })

    if (reply && reply.ok) {
      const assistantMessage = appendMessage(db, {
        ticketId,
        role: 'assistant',
        content: reply.content,
        now: now(),
        tokens: reply.tokens || 0,
      })
      finishTurn(db, {
        ticketId,
        sessionId: reply.sessionId || '',
        status: STATUS_ANSWERED,
        now: now(),
      })
      return assistantMessage
    }

    const reason = (reply && reply.reason) || '未知错误'
    logger.warn(`[lyra-desk] AI turn failed ticket=${ticketId} reason=${reason}`)
    const assistantMessage = appendMessage(db, {
      ticketId,
      role: 'assistant',
      content: `抱歉，本轮回答失败：${reason}`,
      now: now(),
    })
    // Keep the ticket open so the user can retry; the failure bubble is the
    // visible record of what happened.
    finishTurn(db, { ticketId, sessionId: '', status: STATUS_OPEN, now: now() })
    return assistantMessage
  }

  async function handle(req, res) {
    const started = Date.now()
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch {
      return json(res, 400, { error: 'Bad request' })
    }
    // nginx rewrites /tickets-api/xxx → /api/xxx; accept the raw prefix too so
    // a direct call through the edge cannot silently 404.
    let path = url.pathname.replace(/^\/tickets-api(?=\/|$)/, '/api')
    path = path.replace(/\/+$/, '') || '/'

    const responded = res
    res.on('finish', () => {
      // Request line only — never headers, bodies, tokens or keys.
      logger.info(`[lyra-desk] ${req.method} ${path} ${responded.statusCode} ${Date.now() - started}ms`)
    })

    const corsAllowed = applyCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(corsAllowed ? 204 : 403, corsAllowed ? {} : { 'content-type': 'application/json; charset=utf-8' })
      return res.end(corsAllowed ? '' : JSON.stringify({ error: 'Forbidden' }))
    }

    if (path === '/api/health') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' })
      const ai = await hermes.health(now())
      return json(res, 200, { ok: true, ai: !!ai })
    }

    if (path !== '/api/tickets' && !path.startsWith('/api/tickets/')
      && path !== '/api/admin/tickets' && !path.startsWith('/api/admin/tickets/')) {
      return json(res, 404, { error: 'Not found' })
    }

    const identity = await authenticate(req)
    if (!identity) return json(res, 401, { error: 'Unauthorized' })
    const { userId } = identity

    // ---- /api/admin/tickets ----
    if (path === '/api/admin/tickets' || path.startsWith('/api/admin/tickets/')) {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' })
      if (!isAdmin(identity)) return json(res, 403, { error: 'Forbidden' })
      if (path === '/api/admin/tickets') {
        return json(res, 200, { tickets: listAllTickets(db).map(toAdminTicket) })
      }
      // Admin detail view is read-only: there is no reply-as-user endpoint.
      const adminId = parseId(path.slice('/api/admin/tickets/'.length))
      const row = adminId === null ? null : getTicketRow(db, adminId)
      if (!row) return json(res, 404, { error: '工单不存在' })
      return json(res, 200, {
        ticket: { ...toApiTicket(row, messagesFor(db, row.id)), userId: row.user_id },
      })
    }

    // ---- /api/tickets ----
    if (path === '/api/tickets') {
      if (req.method === 'GET') {
        return json(res, 200, { tickets: listTicketsForUser(db, userId).map(r => toApiTicket(r)) })
      }
      if (req.method === 'POST') {
        let body
        try {
          body = await readBody(req)
        } catch (e) {
          return json(res, e.statusCode || 400, { error: e.message === 'body too large' ? '请求体过大' : '无效的 JSON' })
        }
        const title = str(body.title).trim()
        const content = str(body.body).trim()
        if (!title) return json(res, 400, { error: '标题不能为空' })
        if (chars(title) > MAX_TITLE_CHARS) return json(res, 400, { error: `标题不能超过 ${MAX_TITLE_CHARS} 字` })
        if (!content) return json(res, 400, { error: '内容不能为空' })
        if (chars(content) > MAX_CONTENT_CHARS) return json(res, 400, { error: `内容不能超过 ${MAX_CONTENT_CHARS} 字` })

        // The first user message is part of ticket creation, so it is written
        // before the AI turn runs (and therefore before the lock is needed).
        const created = createTicket(db, { userId, title, body: content, now: now() })
        let assistantMessage = null
        try {
          assistantMessage = await serialize(created.ticketId, () => answerTurn(created.ticketId))
        } catch (err) {
          logger.error(`[lyra-desk] ticket create turn crashed: ${String(err && err.message || err)}`)
        }
        const ticket = detailFor(created.ticketId)
        return json(res, 200, { ticket, assistantMessage })
      }
      return json(res, 405, { error: 'Method not allowed' })
    }

    // ---- /api/tickets/:id[/close|/reopen|/messages] ----
    const m = path.match(/^\/api\/tickets\/([^/]+)(?:\/(close|reopen|messages))?$/)
    if (!m) return json(res, 404, { error: 'Not found' })
    const ticketId = parseId(m[1])
    if (ticketId === null) return json(res, 404, { error: 'Not found' })
    const action = m[2] || ''
    const ticket = ownedTicket(ticketId, userId)
    if (!ticket) return json(res, 404, { error: '工单不存在' })

    if (action === '') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' })
      return json(res, 200, { ticket: detailFor(ticketId) })
    }

    if (action === 'close' || action === 'reopen') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })
      const status = action === 'close' ? STATUS_CLOSED : STATUS_OPEN
      const row = setTicketStatus(db, ticketId, status, now())
      return json(res, 200, { ticket: toApiTicket(row, messagesFor(db, ticketId)) })
    }

    // ---- action === 'messages' ----
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message === 'body too large' ? '请求体过大' : '无效的 JSON' })
    }
    const content = str(body.content).trim()
    if (!content) return json(res, 400, { error: '内容不能为空' })
    if (chars(content) > MAX_CONTENT_CHARS) return json(res, 400, { error: `内容不能超过 ${MAX_CONTENT_CHARS} 字` })
    if (ticket.status === STATUS_CLOSED) return json(res, 400, { error: '工单已关闭，请先重新打开' })

    // The user message and the answer are written inside the same ticket lock,
    // so two concurrent submissions cannot interleave their history.
    let result = null
    try {
      result = await serialize(ticketId, async () => {
        const userMessage = appendMessage(db, {
          ticketId,
          role: 'user',
          content,
          now: now(),
        })
        const assistantMessage = await answerTurn(ticketId)
        return { userMessage, assistantMessage }
      })
    } catch (err) {
      logger.error(`[lyra-desk] message turn crashed ticket=${ticketId}: ${String(err && err.message || err)}`)
    }
    if (!result || !result.assistantMessage) {
      return json(res, 500, { error: '本轮处理失败，请重试' })
    }
    return json(res, 200, {
      messages: [result.userMessage, result.assistantMessage].map(msg => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        created_at: msg.created_at,
        tokens: msg.tokens,
      })),
      ticket: detailFor(ticketId),
    })
  }

  return { handle, auth, chains, detailFor }
}

/** Start the server. Exported so tests can bind port 0. */
export function startServer({
  host = process.env.LD_HOST || DEFAULT_HOST,
  port = Number(process.env.LD_PORT || DEFAULT_PORT),
  dbPath = process.env.LD_DB_PATH || DEFAULT_DB_PATH,
  verifier = verifyAgainstStudio,
  studioBase = process.env.LD_STUDIO_BASE || DEFAULT_STUDIO_BASE,
  hermes = null,
  logger = console,
} = {}) {
  if (!isLoopbackHost(host)) {
    throw new Error(`LD_HOST must be a loopback address (got ${host})`)
  }
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = openDb(dbPath)
  migrate(db)

  const client = hermes || createHermesClient({ baseUrl: process.env.LD_HERMES_URL })
  const app = createApp({
    db,
    hermes: client,
    verify: token => verifier(token, studioBase),
    logger,
  })

  const server = createServer((req, res) => {
    app.handle(req, res).catch(err => {
      logger.error(`[lyra-desk] unhandled: ${String(err && err.stack || err)}`)
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' })
      else res.end()
    })
  })
  // AI turns can take up to 180s; Node's defaults are below that.
  server.requestTimeout = 240_000
  server.headersTimeout = 60_000

  server.listen(port, host, () => {
    logger.info(`[lyra-desk] listening on http://${host}:${port} db=${dbPath}`)
  })
  return { server, db, app }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    startServer()
  } catch (err) {
    console.error(`[lyra-desk] fatal: ${String(err && err.message || err)}`)
    process.exit(1)
  }
}
