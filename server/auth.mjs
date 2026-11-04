// Studio identity verification.
//
// The Studio JWT signing key is private, so the only supported way to learn
// "which user is this token" is to ask Studio itself at GET /api/auth/me.
// Results are cached in-process for 60s keyed by sha256(token); failures are
// cached for 5s so a typo'd token cannot hammer Studio while a fresh login
// still works almost immediately.
import { createHash } from 'node:crypto'

export const DEFAULT_STUDIO_BASE = 'http://127.0.0.1:8648'
export const AUTH_CACHE_TTL_MS = 60_000
export const AUTH_NEGATIVE_TTL_MS = 5_000

const MAX_CACHE_ENTRIES = 512

export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** Extract `user.id` and `user.role` from a /api/auth/me response body. */
export function identityFromMe(body) {
  const user = body && body.user
  if (!user || !Number.isInteger(user.id) || user.id <= 0) return null
  return {
    userId: user.id,
    role: typeof user.role === 'string' ? user.role : '',
    user,
  }
}

/** Real verifier: asks Studio. Returns an identity object or null. */
export async function verifyAgainstStudio(token, base = DEFAULT_STUDIO_BASE, timeoutMs = 5_000) {
  let res
  try {
    res = await fetch(new URL('/api/auth/me', base), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let body
  try { body = await res.json() } catch { return null }
  return identityFromMe(body)
}

/**
 * Wraps a verifier with the sizing described above.
 * `verify` is injectable so tests can run without Studio.
 */
export function createAuthCache(verify = verifyAgainstStudio, now = Date.now) {
  const cache = new Map()

  function prune(t) {
    if (cache.size < MAX_CACHE_ENTRIES) return
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= t) cache.delete(key)
    }
    // Still full of live entries: drop the oldest insertion order entries.
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  return {
    async verify(token) {
      if (!token || typeof token !== 'string') return null
      const key = tokenHash(token)
      const t = now()
      const hit = cache.get(key)
      if (hit && hit.expiresAt > t) return hit.value
      let value = null
      try { value = await verify(token) } catch { value = null }
      if (!value) value = null
      if (value) prune(t)
      cache.set(key, {
        value,
        expiresAt: t + (value ? AUTH_CACHE_TTL_MS : AUTH_NEGATIVE_TTL_MS),
      })
      return value
    },
    size() { return cache.size },
    clear() { cache.clear() },
  }
}

/** Bearer token from an Authorization header, or ''. */
export function bearerToken(req) {
  const header = (req && req.headers && req.headers.authorization) || ''
  const m = String(header).match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : ''
}

/** Admin tiers allowed to read every ticket. */
export const ADMIN_ROLES = new Set(['super_admin', 'admin'])

export function isAdmin(identity) {
  return !!identity && ADMIN_ROLES.has(identity.role)
}
