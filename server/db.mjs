// SQLite access for the Lyra Desk ticket store.
//
// Only node:sqlite (built into Node 22+); no npm dependencies. This database
// is completely separate from Studio's hermes-web-ui.db: ticket content must
// never land in the shared Hermes memory databases.
import { DatabaseSync } from 'node:sqlite'

export const DEFAULT_DB_PATH = '/root/work/lyra_desk/data/tickets.db'

const TICKETS_DDL = `
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  lyra_session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`

const TICKET_MESSAGES_DDL = `
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0
)`

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_tm_ticket ON ticket_messages(ticket_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, updated_at)`,
]

/** Open (and create) the ticket database. */
export function openDb(path = DEFAULT_DB_PATH) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

/** Idempotent schema setup; safe to run on every start. */
export function migrate(db) {
  db.exec(TICKETS_DDL)
  db.exec(TICKET_MESSAGES_DDL)
  for (const sql of INDEXES) db.exec(sql)
}

/** Run `fn` inside an immediate transaction. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
}

/**
 * Create a ticket and its first user message atomically. The message row is
 * returned so the caller can hand it straight to the AI turn without inserting
 * the same text twice.
 */
export function createTicket(db, { userId, title, body, now }) {
  return transaction(db, () => {
    const t = db.prepare(
      'INSERT INTO tickets (user_id, title, status, lyra_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(userId, title, 'open', '', now, now)
    const ticketId = Number(t.lastInsertRowid)
    const m = db.prepare(
      'INSERT INTO ticket_messages (ticket_id, role, content, created_at, tokens) VALUES (?, ?, ?, ?, 0)',
    ).run(ticketId, 'user', body, now)
    return {
      ticketId,
      userMessage: {
        id: Number(m.lastInsertRowid),
        ticket_id: ticketId,
        role: 'user',
        content: body,
        created_at: now,
        tokens: 0,
      },
    }
  })
}

export function getTicketRow(db, id) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) || null
}

export function messagesFor(db, ticketId) {
  return db.prepare(
    'SELECT id, ticket_id, role, content, created_at, tokens FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC',
  ).all(ticketId)
}

/**
 * Ticket rows with derived messageCount/lastMessage. The correlated
 * subqueries keep this to one query per list, which matters very little at
 * this scale but keeps the API honest about "last message" ordering.
 */
function listRows(db, sql, ...params) {
  return db.prepare(sql).all(...params)
}

const LIST_COLUMNS = `
  t.id, t.user_id, t.title, t.status, t.created_at, t.updated_at,
  (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
  (SELECT m.content FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message
`

export function listTicketsForUser(db, userId) {
  return listRows(
    db,
    `SELECT ${LIST_COLUMNS} FROM tickets t WHERE t.user_id = ? ORDER BY t.updated_at DESC, t.id DESC`,
    userId,
  )
}

export function listAllTickets(db) {
  return listRows(
    db,
    `SELECT ${LIST_COLUMNS} FROM tickets t ORDER BY t.updated_at DESC, t.id DESC`,
  )
}

export function appendMessage(db, { ticketId, role, content, now, tokens = 0 }) {
  return transaction(db, () => {
    const r = db.prepare(
      'INSERT INTO ticket_messages (ticket_id, role, content, created_at, tokens) VALUES (?, ?, ?, ?, ?)',
    ).run(ticketId, role, content, now, tokens)
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, ticketId)
    return {
      id: Number(r.lastInsertRowid),
      ticket_id: ticketId,
      role,
      content,
      created_at: now,
      tokens,
    }
  })
}

/**
 * Persist the outcome of one AI turn. `sessionId` is only overwritten when the
 * upstream actually returned one, so a probe/failed turn cannot wipe a good
 * session binding.
 */
export function finishTurn(db, { ticketId, sessionId, status, now }) {
  return transaction(db, () => {
    if (sessionId) {
      db.prepare(
        'UPDATE tickets SET lyra_session_id = ?, status = ?, updated_at = ? WHERE id = ?',
      ).run(sessionId, status, now, ticketId)
    } else {
      db.prepare(
        'UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?',
      ).run(status, now, ticketId)
    }
    return getTicketRow(db, ticketId)
  })
}

export function setTicketStatus(db, id, status, now) {
  db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
  return getTicketRow(db, id)
}

const LAST_MESSAGE_LIMIT = 160

/** DB row → list/detail API shape. Internal session id is deliberately hidden. */
export function toApiTicket(row, messages = null) {
  const out = {
    id: row.id,
    title: row.title,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    messageCount: row.message_count !== undefined
      ? row.message_count
      : (messages ? messages.length : 0),
    lastMessage: row.last_message !== undefined
      ? clip(row.last_message)
      : clip(messages && messages.length ? messages[messages.length - 1].content : ''),
  }
  if (messages) {
    out.messages = messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
      tokens: m.tokens,
    }))
  }
  return out
}

function clip(text) {
  const s = String(text || '')
  return s.length > LAST_MESSAGE_LIMIT ? s.slice(0, LAST_MESSAGE_LIMIT) + '…' : s
}

/** Admin list rows additionally expose the owner id. */
export function toAdminTicket(row) {
  return { ...toApiTicket(row), userId: row.user_id }
}
