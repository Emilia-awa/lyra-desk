// Hermes (lyra-desk profile) chat client.
//
// The lyra-desk profile exposes an OpenAI-compatible endpoint on 127.0.0.1:8643.
// Every reply carries `X-Hermes-Session-Id`; replaying that header on later
// turns keeps the server-side conversation continuous. We also resend the full
// ticket history in `messages`, so the answer stays reproducible even if the
// server-side session is ever lost.
//
// The API key is read from the process environment only (systemd loads it via
// EnvironmentFile). It is never logged and never leaves this module.

export const DEFAULT_HERMES_URL = 'http://127.0.0.1:8643'
// 工单 AI 现在会真去跑工具（grep 产物、读日志、改魔改层再验），一轮几十秒很正常。
export const DEFAULT_TIMEOUT_MS = 420_000

/**
 * 系统提示。要点：这个 profile 有真终端和文件工具，工单 AI 必须能自己去翻 Lyra 的代码和日志
 * 定位问题，而不是靠「我猜」。边界写在提示里，因为它在无人值守通道上跑（审批已关）。
 */
export const SYSTEM_PROMPT = `你是 Lyra Studio 的内置支持助手，跑在一台能直接登进 Lyra 所在机器的 Hermes 上。
用户在工作台里提问题、报 bug、提需求，你要**真的去查**，不是凭印象答。

## 你手上有什么

- 文件读写、终端、Python 执行、浏览器、抓网页。全部可用。
- 这就是 Lyra 跑的那台机器。下面这些是它真实的落点：

| 东西 | 路径 |
|---|---|
| 前端编译产物 | /root/.hermes/tools/node-26.12.1-linux-x64/lib/node_modules/ekko-studio/dist/client/ |
| 魔改注入层 | 同上 assets/js/emt-*.js 与 assets/css/emt-*.css（这些是自写的，改了直接生效） |
| index.html | 同上 dist/client/index.html（魔改注入都挂在这里） |
| 后端编译产物 | .../ekko-studio/dist/server/index.js（13MB 单文件，grep 用） |
| 启动器 / 日志 | /root/ekko-tunnel/start-studio-service.sh、/root/ekko-tunnel/logs/studio.log |
| 中继 | /root/ekko-tunnel/relay.mjs（8791） |
| Agent 名片侧车 | /root/work/emt_agents/（8652，server/index.mjs） |
| 工单侧车（你自己） | /root/work/lyra_desk/（8653） |
| 日历 | /root/calendar/（API 8795） |
| 反代 | /etc/nginx/snippets/ekko-locations.conf |
| 服务单元 | systemctl: ekko-studio / ekko-relay / emt-agents / lyra-desk-tickets / calendar-api |

## 怎么答

1. **先查再答**。用户说「XX 按钮没有」「点了没反应」，用 grep 在对应产物里找实体，看日志有没有报错。
   查不到就跟用户说「这个功能在代码里不存在」，别说「可能没配好」。
2. 报 bug：先复述现象 + 复现条件，再给结论。有日志就贴那几行。
3. 问怎么用：给具体路径（点哪里、填什么）。
4. 提需求：写清要什么、影响面、能不能做。
5. 有把握的小问题**直接修**：改 emt-*.js / emt-*.css 这类魔改层、改 /root/work/ 下的侧车、修 nginx 配置片段。
   改完必须验（浏览器真开一遍，或 curl 打接口看真返回），把读数和改动一起说。
6. 修不了或风险大的（改 dist/server/index.js、改 Hermes 本体、动数据库结构、重启别人的服务），
   不要硬上：写清「卡在哪 + 该怎么改」，让维护者接手。

## 硬边界

- 只动 Lyra 自己的东西（上表路径）。**不许**碰 /root/.hermes/（除了你自己 profile 下）、
  /root/.hermes/profiles/coconut/、其他用户的数据库、别人的服务。
- 不许删文件、不许删容器、不许清库。要删先问。
- 不许把 IP、token、凭据写进回答。
- 不编造 Lyra 里不存在的东西。不确定就说不确定。

## 输出

中文，先结论后理由。代码/日志用代码块，别贴大段。控制在 600 字以内，除非用户要细节。`


const MAX_REASON_LEN = 120

/**
 * Turn any failure into a short, user-safe reason. Never includes the API key,
 * the token, or a full response body.
 */
export function shortReason(err) {
  if (!err) return '未知错误'
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return '上游超时'
  if (typeof err.status === 'number') {
    if (err.status === 401 || err.status === 403) return '上游鉴权失败'
    if (err.status === 429) return '上游限流'
    return `上游返回 ${err.status}`
  }
  const msg = typeof err.message === 'string' ? err.message : String(err)
  const trimmed = msg.replace(/\s+/g, ' ').trim()
  if (!trimmed) return '上游连接失败'
  return trimmed.length > MAX_REASON_LEN ? trimmed.slice(0, MAX_REASON_LEN) + '…' : trimmed
}

/**
 * Create a client bound to one endpoint.
 * `fetchImpl` and `timeoutMs` are injectable so tests can use a local stub.
 */
export function createHermesClient({
  baseUrl = process.env.LD_HERMES_URL || DEFAULT_HERMES_URL,
  apiKey = process.env.API_SERVER_KEY || '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const endpoint = new URL('/v1/chat/completions', baseUrl)

  /** Low-level call. Returns {ok:true,...} or {ok:false, reason}. */
  async function complete(messages, { sessionId = '', maxTokens = null, timeout = timeoutMs } = {}) {
    if (!apiKey) return { ok: false, reason: '未配置上游密钥' }
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    }
    if (sessionId) headers['x-hermes-session-id'] = sessionId
    const body = { model: 'hermes-agent', messages, stream: false }
    if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens

    let res
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (err) {
      return { ok: false, reason: shortReason(err) }
    }

    if (!res.ok) {
      // Drain the body so the socket is reusable; the text never reaches a log.
      try { await res.text() } catch {}
      return { ok: false, reason: shortReason({ status: res.status }) }
    }

    let payload
    try {
      payload = await res.json()
    } catch {
      return { ok: false, reason: '上游响应不是 JSON' }
    }

    const content = payload
      && payload.choices && payload.choices[0]
      && payload.choices[0].message
      && typeof payload.choices[0].message.content === 'string'
      ? payload.choices[0].message.content.trim()
      : ''
    if (!content) return { ok: false, reason: '上游返回空回答' }

    const usage = payload.usage || {}
    const tokens = Number.isFinite(usage.total_tokens) && usage.total_tokens > 0
      ? Math.trunc(usage.total_tokens)
      : 0

    return {
      ok: true,
      content,
      sessionId: (res.headers.get('x-hermes-session-id') || '').trim(),
      tokens,
    }
  }

  /**
   * One ticket turn: system prompt first, then the ticket's full user/assistant
   * history (the caller appends the just-inserted user message).
   */
  async function answer({ history, sessionId = '', timeout }) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history]
    return complete(messages, { sessionId, timeout })
  }

  let probeCache = { at: 0, value: false }

  /** Cached one-word liveness probe (60s). Never throws. */
  async function health(now = Date.now(), ttlMs = 60_000) {
    if (probeCache.at && now - probeCache.at < ttlMs) return probeCache.value
    const r = await complete(
      [
        { role: 'system', content: '你是健康检查探针。只回一个词：ok' },
        { role: 'user', content: 'ping' },
      ],
      { maxTokens: 8, timeout: 20_000 },
    ).catch(() => ({ ok: false }))
    probeCache = { at: now, value: !!r.ok }
    return probeCache.value
  }

  /** Test hook: forget the cached probe result. */
  function resetHealthCache() { probeCache = { at: 0, value: false } }

  return { complete, answer, health, resetHealthCache, endpoint: String(endpoint) }
}
