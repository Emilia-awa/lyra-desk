/* 工单系统（魔改）—— 纯 DOM 注入
 *
 * 做的事：
 *   1. 页面右缘一个竖排「工单」按钮（right:0; top:38%），点开右侧 420px 抽屉
 *   2. 列表态：我的工单（标题 / 状态点 / 最后消息摘要 / 相对时间）+「＋ 新建工单」
 *   3. 详情态：用户右侧、助手左侧气泡，底部输入框发送；失败气泡可重试
 *   4. 管理员（super_admin / admin）多一个「全部工单」分段，只读查看，不能代答
 *
 * 不改任何原生 chunk；出问题删掉 index.html 里 emt-tickets.css / emt-tickets.js
 * 两行即完全恢复。
 *
 * 后端地址：优先 same-origin /tickets-api（nginx 转发到 8653/api），
 * 直连 8648 且没有 nginx 时回落到 http://127.0.0.1:8653/api（侧车只放行
 * loopback Origin 的 CORS）。
 */
(function () {
  'use strict'

  var DRAWER_ID = 'ld-tickets-drawer'
  var FAB_ID = 'ld-tickets-fab'
  var MAX_TITLE = 200
  var MAX_CONTENT = 8000
  var TICKET_TIMEOUT_MS = 200000

  var state = {
    open: false,
    view: 'list',          // list | detail | new
    scope: 'mine',         // mine | all（管理员）
    isAdmin: false,
    tickets: [],
    detail: null,          // 当前工单（含 messages）
    loading: false,
    sending: false,
    error: '',
    pending: null,         // {ticketId, content} 用于重试
    apiBase: null,         // '/tickets-api' | 'http://127.0.0.1:8653/api'
  }

  /* --------------------------------------------------------------- 工具 */

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = String(text)
    return node
  }

  function apiKey() {
    try { return localStorage.getItem('hermes_api_key') || '' } catch (e) { return '' }
  }

  function originOf() {
    return location.origin || (location.protocol + '//' + location.host)
  }

  function isLoopbackPage() {
    return location.hostname === '127.0.0.1' || location.hostname === 'localhost'
      || location.hostname === '::1' || location.hostname === '[::1]'
  }

  /* ------------------------------------------------------------- 地址层 */

  /**
   * 解析后端前缀。不做网络探测：探测一旦被 Studio 的 SPA fallback 拖慢，
   * 整个抽屉就会白等 2.5s 以上。
   *
   * - 页面本身就在 8653：直接用 /api
   * - loopback 页面（本机直连 8648，没有 nginx）：直接打 8653
   * - 其它（走域名 / nginx）：用 /tickets-api
   *
   * GET 请求遇到非 JSON 或网络错误时会自动换另一个前缀重试一次，
   * 所以猜错也不会把抽屉卡死；POST 绝不自动重试（避免重复建单）。
   */
  function alternateBase(current) {
    var prefix = originOf() + '/tickets-api'
    var direct = 'http://127.0.0.1:8653/api'
    return current === prefix ? direct : prefix
  }

  function resolveBase() {
    if (state.apiBase) return Promise.resolve(state.apiBase)
    if (location.port === '8653') state.apiBase = originOf() + '/api'
    else if (isLoopbackPage()) state.apiBase = 'http://127.0.0.1:8653/api'
    else state.apiBase = originOf() + '/tickets-api'
    return Promise.resolve(state.apiBase)
  }

  function request(base, path, o) {
    var headers = { accept: 'application/json' }
    var token = apiKey()
    if (token) headers.Authorization = 'Bearer ' + token
    if (o.body !== undefined) headers['Content-Type'] = 'application/json'
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = ctrl ? setTimeout(function () { ctrl.abort() }, o.timeoutMs || TICKET_TIMEOUT_MS) : null
    return fetch(base + path, {
      method: o.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null
        try { data = txt ? JSON.parse(txt) : null } catch (e) { data = null }
        if (data === null) {
          // 典型情形：没有 nginx 前缀，请求被 Studio 的 SPA fallback 吃了。
          return { ok: false, status: r.status, data: null, error: '接口未就绪（HTTP ' + r.status + '）', nonJson: true }
        }
        return {
          ok: r.ok,
          status: r.status,
          data: data,
          error: (data && data.error) || (r.ok ? '' : 'HTTP ' + r.status),
        }
      })
    }).catch(function (e) {
      return {
        ok: false,
        status: 0,
        data: null,
        network: true,
        error: e && e.name === 'AbortError' ? '请求超时，请重试' : '网络错误，请重试',
      }
    }).finally(function () { if (timer) clearTimeout(timer) })
  }

  function api(path, opts) {
    var o = opts || {}
    var method = o.method || 'GET'
    return resolveBase().then(function (base) {
      return request(base, path, o).then(function (res) {
        // 只有「压根不是 JSON」（SPA fallback / 404 页面）或网络层失败才换前缀；
        // 真正的业务 404 是合法答案，重试没意义。
        var mayRetry = method === 'GET' && !o.disableFallback && (res.network || res.nonJson)
        if (!mayRetry) return res
        var other = alternateBase(base)
        if (other === base) return res
        return request(other, path, o).then(function (second) {
          if (!second.network && !second.nonJson) state.apiBase = other
          return second.ok || !res.ok ? second : res
        })
      })
    })
  }

  /* ------------------------------------------------------------- 数据层 */

  function loadAdminFlag() {
    var token = apiKey()
    if (!token) return Promise.resolve(false)
    var cacheKey = 'ld_tickets_is_admin'
    var cached = ''
    try { cached = sessionStorage.getItem(cacheKey) || '' } catch (e) { cached = '' }
    if (cached === '1' || cached === '0') {
      // 先用上次结果渲染，同时在后台再确认一次（角色可能被管理员改掉）
      confirmAdmin(token, cacheKey)
      return Promise.resolve(cached === '1')
    }
    return confirmAdmin(token, cacheKey)
  }

  function confirmAdmin(token, cacheKey) {
    return fetch(originOf() + '/api/auth/me', {
      headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
      credentials: 'same-origin',
      signal: AbortSignal.timeout(6000),
    }).then(function (r) {
      if (!r.ok) return false
      return r.json()
    }).then(function (b) {
      var role = b && b.user && b.user.role
      var isAdmin = role === 'super_admin' || role === 'admin'
      try { sessionStorage.setItem(cacheKey, isAdmin ? '1' : '0') } catch (e) {}
      if (isAdmin !== state.isAdmin) {
        state.isAdmin = isAdmin
        if (state.open) render()
      }
      return isAdmin
    }).catch(function () { return state.isAdmin })
  }

  var listSeq = 0

  function refreshList() {
    var seq = ++listSeq
    state.loading = true
    state.error = ''
    render()
    var scope = state.scope
    var path = scope === 'all' ? '/admin/tickets' : '/tickets'
    return api(path).then(function (res) {
      // 切换「我的 / 全部」或连续刷新时，先发出的请求可能后到：丢弃过期结果。
      if (seq !== listSeq) return
      state.loading = false
      if (!res.ok) {
        state.error = res.error || '读取工单失败'
        state.tickets = []
      } else {
        state.tickets = (res.data && res.data.tickets) || []
      }
      render()
    })
  }

  var detailSeq = 0

  function loadDetail(id) {
    var seq = ++detailSeq
    state.loading = true
    state.error = ''
    state.view = 'detail'
    state.detail = null
    render()
    var path = state.scope === 'all' ? '/admin/tickets/' + id : '/tickets/' + id
    return api(path).then(function (res) {
      if (seq !== detailSeq) return
      state.loading = false
      if (!res.ok) {
        state.error = res.error || '读取工单失败'
        if (res.status === 404) state.view = 'list'
        render()
        return
      }
      state.detail = res.data.ticket
      render()
    })
  }

  function openTicket(id) {
    state.detail = { id: id, title: '', status: 'open', messages: [] }
    loadDetail(id)
  }

  function createTicket(title, body) {
    state.sending = true
    state.error = ''
    render()
    return api('/tickets', { method: 'POST', body: { title: title, body: body } }).then(function (res) {
      state.sending = false
      if (!res.ok) {
        state.error = res.error || '建单失败'
        render()
        return
      }
      state.scope = 'mine'
      state.detail = res.data.ticket
      state.view = 'detail'
      render()
      scrollToBottom()
    })
  }

  function sendMessage(text) {
    var ticket = state.detail
    if (!ticket || state.sending) return
    state.sending = true
    state.error = ''
    state.pending = { ticketId: ticket.id, content: text }
    // 乐观渲染：先上用户气泡，再挂一个「思考中…」占位
    ticket.messages = (ticket.messages || []).concat([
      { id: 'tmp-user-' + Date.now(), role: 'user', content: text, created_at: Date.now() },
      { id: 'tmp-pending', role: 'assistant', content: '思考中…', pending: true },
    ])
    render()
    scrollToBottom()

    return api('/tickets/' + ticket.id + '/messages', {
      method: 'POST',
      body: { content: text },
    }).then(function (res) {
      state.sending = false
      if (!res.ok) {
        state.error = res.error || '发送失败'
        state.detail = state.detail || ticket
        state.detail.messages = ticket.messages.filter(function (m) { return m.id !== 'tmp-pending' })
        state.detail.failed = true
        render()
        return
      }
      state.pending = null
      state.detail = res.data.ticket
      render()
      scrollToBottom()
    })
  }

  function setStatus(action) {
    var ticket = state.detail
    if (!ticket || state.sending) return
    var id = ticket.id
    api('/tickets/' + id + '/' + action, { method: 'POST' }).then(function (res) {
      if (!res.ok) {
        state.error = res.error || '操作失败'
        render()
        return
      }
      state.detail = res.data.ticket
      render()
      if (state.scope === 'mine') refreshListQuiet()
    })
  }

  function refreshListQuiet() {
    var seq = ++listSeq
    var path = state.scope === 'all' ? '/admin/tickets' : '/tickets'
    return api(path).then(function (res) {
      if (seq !== listSeq) return
      if (res.ok) {
        state.tickets = (res.data && res.data.tickets) || []
        render()
      }
    })
  }

  /* --------------------------------------------------------------- 展示 */

  function relTime(ts) {
    var n = Number(ts) || 0
    if (!n) return ''
    var diff = Date.now() - n
    if (diff < 0) diff = 0
    var min = Math.floor(diff / 60000)
    if (min < 1) return '刚刚'
    if (min < 60) return min + ' 分钟前'
    var hour = Math.floor(min / 60)
    if (hour < 24) return hour + ' 小时前'
    var day = Math.floor(hour / 24)
    if (day < 7) return day + ' 天前'
    var d = new Date(n)
    return (d.getMonth() + 1) + '月' + d.getDate() + '日'
  }

  function statusLabel(s) {
    if (s === 'answered') return '已回复'
    if (s === 'closed') return '已关闭'
    return '待处理'
  }

  var drawer = null

  function ensureDrawer() {
    if (drawer && drawer.isConnected) return drawer
    drawer = document.getElementById(DRAWER_ID)
    if (drawer) return drawer

    drawer = el('section', 'ld-drawer')
    drawer.id = DRAWER_ID
    drawer.setAttribute('role', 'dialog')
    drawer.setAttribute('aria-label', '我的工单')
    drawer.addEventListener('click', function (ev) {
      // 点抽屉空白不关；只有显式关闭键才关，避免误触丢草稿
      if (ev.target === drawer) return
    })
    document.body.appendChild(drawer)
    return drawer
  }

  function render() {
    var root = ensureDrawer()
    root.classList.toggle('ld-open', state.open)
    if (!state.open) {
      root.setAttribute('aria-hidden', 'true')
      return
    }
    root.setAttribute('aria-hidden', 'false')
    root.textContent = ''

    var header = el('div', 'ld-header')
    if (state.view === 'detail') {
      var back = el('button', 'ld-icon-btn', '← 返回')
      back.type = 'button'
      back.setAttribute('data-act', 'back')
      back.addEventListener('click', function () {
        state.view = 'list'
        state.detail = null
        state.error = ''
        state.pending = null
        render()
        refreshList()
      })
      header.appendChild(back)
    }
    header.appendChild(el('div', 'ld-title', state.view === 'detail'
      ? ((state.detail && state.detail.title) || '工单')
      : (state.scope === 'all' ? '全部工单' : '我的工单')))

    if (state.view === 'list' && state.isAdmin) {
      var seg = el('div', 'ld-seg')
      var mineBtn = el('button', state.scope === 'mine' ? 'ld-on' : '', '我的')
      mineBtn.type = 'button'
      mineBtn.setAttribute('data-act', 'scope-mine')
      mineBtn.addEventListener('click', function () {
        if (state.scope === 'mine') return
        state.scope = 'mine'
        refreshList()
      })
      var allBtn = el('button', state.scope === 'all' ? 'ld-on' : '', '全部工单')
      allBtn.type = 'button'
      allBtn.setAttribute('data-act', 'scope-all')
      allBtn.addEventListener('click', function () {
        if (state.scope === 'all') return
        state.scope = 'all'
        refreshList()
      })
      seg.appendChild(mineBtn)
      seg.appendChild(allBtn)
      header.appendChild(seg)
    }

    if (state.view === 'detail' && state.detail && state.scope === 'mine' && state.detail.id) {
      var toggle = el('button', 'ld-icon-btn',
        state.detail.status === 'closed' ? '重新打开' : '关闭工单')
      toggle.type = 'button'
      toggle.setAttribute('data-act', 'toggle-status')
      toggle.addEventListener('click', function () {
        setStatus(state.detail.status === 'closed' ? 'reopen' : 'close')
      })
      header.appendChild(toggle)
    }

    var close = el('button', 'ld-icon-btn', '✕')
    close.type = 'button'
    close.setAttribute('aria-label', '关闭')
    close.setAttribute('data-act', 'close')
    close.addEventListener('click', closeDrawer)
    header.appendChild(close)
    root.appendChild(header)

    var body = el('div', 'ld-body')
    root.appendChild(body)

    if (state.error) body.appendChild(el('div', 'ld-error', state.error))

    if (state.view === 'list') renderList(body)
    else if (state.view === 'new') renderForm(body)
    else renderDetail(body)
  }

  function renderList(body) {
    if (state.loading) {
      body.appendChild(el('div', 'ld-empty', '加载中…'))
      return
    }
    if (!state.tickets.length) {
      body.appendChild(el('div', 'ld-empty',
        state.scope === 'all' ? '还没有任何工单' : '还没有工单\n有问题、建议或 bug 都可以提一单'))
    }
    state.tickets.forEach(function (t) {
      var card = el('button', 'ld-card')
      card.type = 'button'
      card.setAttribute('data-ticket-id', String(t.id))
      var top = el('div', 'ld-card-top')
      top.appendChild(el('span', 'ld-dot ld-' + (t.status || 'open')))
      top.appendChild(el('span', 'ld-card-title', t.title))
      top.appendChild(el('span', 'ld-card-time', relTime(t.updated_at)))
      card.appendChild(top)
      if (t.lastMessage) card.appendChild(el('div', 'ld-card-last', t.lastMessage))
      var meta = el('div', 'ld-card-meta',
        statusLabel(t.status) + ' · ' + (t.messageCount || 0) + ' 条消息')
      if (state.scope === 'all' && t.userId) meta.appendChild(el('span', 'ld-user-tag', '用户 ' + t.userId))
      card.appendChild(meta)
      card.addEventListener('click', function () { openTicket(t.id) })
      body.appendChild(card)
    })

    var newBtn = el('button', 'ld-primary', '＋ 新建工单')
    newBtn.type = 'button'
    newBtn.setAttribute('data-act', 'new')
    newBtn.style.width = '100%'
    newBtn.style.marginTop = '4px'
    newBtn.disabled = state.scope === 'all'
    newBtn.addEventListener('click', function () {
      state.view = 'new'
      state.error = ''
      render()
    })
    body.appendChild(newBtn)
  }

  function renderForm(body) {
    var form = el('form', 'ld-form')
    form.setAttribute('data-form', 'new-ticket')

    var titleWrap = el('label', null, '标题')
    var titleInput = el('input')
    titleInput.type = 'text'
    titleInput.maxLength = MAX_TITLE
    titleInput.placeholder = '一句话说明问题'
    titleInput.required = true
    titleInput.setAttribute('data-field', 'title')
    titleWrap.appendChild(titleInput)
    form.appendChild(titleWrap)

    var bodyWrap = el('label', null, '正文')
    var bodyInput = el('textarea')
    bodyInput.maxLength = MAX_CONTENT
    bodyInput.placeholder = '详细描述现象、操作步骤、期望结果…'
    bodyInput.required = true
    bodyInput.setAttribute('data-field', 'body')
    bodyWrap.appendChild(bodyInput)
    form.appendChild(bodyWrap)

    var hint = el('div', 'ld-hint', '提交后由 Lyra 内置支持助手直接答复。')
    form.appendChild(hint)

    var actions = el('div', 'ld-actions')
    var cancel = el('button', 'ld-ghost', '取消')
    cancel.type = 'button'
    cancel.addEventListener('click', function () {
      state.view = 'list'
      state.error = ''
      render()
    })
    var submit = el('button', 'ld-primary', state.sending ? '提交中…' : '提交')
    submit.type = 'submit'
    submit.disabled = state.sending
    submit.setAttribute('data-act', 'submit-ticket')
    actions.appendChild(cancel)
    actions.appendChild(submit)
    form.appendChild(actions)

    form.addEventListener('submit', function (ev) {
      ev.preventDefault()
      if (state.sending) return
      var title = titleInput.value.trim()
      var text = bodyInput.value.trim()
      if (!title) { state.error = '标题不能为空'; render(); return }
      if (!text) { state.error = '内容不能为空'; render(); return }
      createTicket(title, text)
    })

    body.appendChild(form)
    setTimeout(function () { try { titleInput.focus() } catch (e) {} }, 30)
  }

  function renderDetail(body) {
    var t = state.detail
    if (!t) {
      body.appendChild(el('div', 'ld-empty', state.loading ? '加载中…' : '工单不存在'))
      return
    }
    if (state.loading) {
      body.appendChild(el('div', 'ld-empty', '加载中…'))
      return
    }
    if (state.scope === 'all') {
      body.appendChild(el('div', 'ld-hint',
        '管理员只读视图 · 用户 ' + (t.userId || '-') + ' · ' + statusLabel(t.status)))
    }
    var msgs = t.messages || []
    if (!msgs.length) body.appendChild(el('div', 'ld-empty', '还没有消息'))
    msgs.forEach(function (m) {
      var row = el('div', 'ld-msg ld-' + (m.role === 'user' ? 'user' : 'assistant'))
      if (m.pending) row.classList.add('ld-pending')
      var failed = m.role === 'assistant' && !m.pending && /^抱歉，本轮回答失败/.test(m.content)
      if (failed) row.classList.add('ld-failed')
      var bubble = el('div', 'ld-bubble', m.content)
      if (m.pending) {
        bubble.textContent = ''
        bubble.appendChild(el('span', 'ld-spin', '◌'))
        bubble.appendChild(document.createTextNode(' 思考中…'))
      }
      row.appendChild(bubble)
      if (failed && state.scope === 'mine') {
        var retry = el('button', 'ld-retry', '重试')
        retry.type = 'button'
        retry.setAttribute('data-act', 'retry')
        retry.addEventListener('click', function () {
          var lastUser = null
          for (var i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') { lastUser = msgs[i]; break }
          }
          if (lastUser) sendMessage(lastUser.content)
        })
        bubble.appendChild(document.createElement('br'))
        bubble.appendChild(retry)
      }
      if (m.role === 'user') row.appendChild(bubble)
      else {
        var wrap = el('div')
        wrap.style.maxWidth = '86%'
        bubble.style.maxWidth = '100%'
        wrap.appendChild(bubble)
        row.appendChild(wrap)
      }
      body.appendChild(row)
    })

    if (state.scope === 'all') {
      body.appendChild(el('div', 'ld-hint', '本版不支持管理员人工代答。'))
      return
    }
    if (t.status === 'closed') {
      var reopenRow = el('div', 'ld-actions')
      var reopen = el('button', 'ld-ghost', '重新打开工单')
      reopen.type = 'button'
      reopen.addEventListener('click', function () { setStatus('reopen') })
      reopenRow.appendChild(reopen)
      body.appendChild(reopenRow)
      return
    }

    var composer = el('div', 'ld-composer')
    var input = el('textarea')
    input.maxLength = MAX_CONTENT
    input.rows = 1
    input.placeholder = '继续追问…'
    input.setAttribute('data-field', 'message')
    input.addEventListener('input', function () {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 120) + 'px'
    })
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault()
        doSend()
      }
    })
    var send = el('button', 'ld-send', state.sending ? '发送中…' : '发送')
    send.type = 'button'
    send.disabled = state.sending
    send.setAttribute('data-act', 'send')
    function doSend() {
      var text = input.value.trim()
      if (!text || state.sending) return
      input.value = ''
      input.style.height = 'auto'
      sendMessage(text)
    }
    send.addEventListener('click', doSend)
    composer.appendChild(input)
    composer.appendChild(send)
    drawer.appendChild(composer)
  }

  function scrollToBottom() {
    var body = drawer && drawer.querySelector('.ld-body')
    if (body) body.scrollTop = body.scrollHeight
  }

  /**
   * emt-mobile.js 会把 ≤768px 下所有 textarea 的 placeholder 改成「发消息…」。
   * 它用 MutationObserver 观察整个 body，所以只在 ensure 里改一次不够：
   * 这里自己也挂一个 observer + 定时器，把工单输入框的文案抢回来。
   */
  var FIELD_PLACEHOLDERS = {
    message: '继续追问…',
    body: '详细描述现象、操作步骤、期望结果…',
  }

  function restoreComposerPlaceholder() {
    if (!drawer) return
    Object.keys(FIELD_PLACEHOLDERS).forEach(function (field) {
      var input = drawer.querySelector('textarea[data-field="' + field + '"]')
      if (!input) return
      if (input.getAttribute('placeholder') !== FIELD_PLACEHOLDERS[field]) {
        input.setAttribute('placeholder', FIELD_PLACEHOLDERS[field])
      }
    })
  }

  function guardPlaceholders() {
    if (!document.body) return
    var mo = new MutationObserver(function () { restoreComposerPlaceholder() })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['placeholder'] })
    setInterval(restoreComposerPlaceholder, 700)
  }

  /* --------------------------------------------------------------- 开关 */

  function openDrawer() {
    state.open = true
    ensureFab()
    render()
    if (!state.isAdmin) {
      loadAdminFlag().then(function (isAdmin) {
        state.isAdmin = !!isAdmin
        render()
      })
    }
    if (state.view === 'list') refreshList()
  }

  function closeDrawer() {
    state.open = false
    render()
  }

  function ensureFab() {
    var fab = document.getElementById(FAB_ID)
    if (fab) return fab
    if (!document.body) return null
    fab = el('button', null, '')
    fab.id = FAB_ID
    fab.type = 'button'
    fab.title = '工单'
    fab.setAttribute('aria-label', '打开工单')
    fab.setAttribute('data-act', 'open-drawer')
    fab.appendChild(document.createTextNode('工单'))
    fab.addEventListener('click', function () {
      if (state.open) closeDrawer()
      else openDrawer()
    })
    document.body.appendChild(fab)
    return fab
  }

  /* --------------------------------------------------------------- 启动 */

  function ensure() {
    if (!document.body) return
    ensureFab()
    if (state.open) {
      // 抽屉被外部 DOM 重建吞掉时补回来
      if (!document.getElementById(DRAWER_ID)) {
        drawer = null
        render()
      }
      restoreComposerPlaceholder()
    } else if (document.getElementById(DRAWER_ID)) {
      var node = document.getElementById(DRAWER_ID)
      if (node.classList.contains('ld-open')) node.classList.remove('ld-open')
    }
  }

  function start() {
    if (window.__emtTicketsInstalled) return
    window.__emtTicketsInstalled = true
    ensure()
    // 进页面就把管理员身份解出来，点开抽屉时不再等这一个请求
    loadAdminFlag().then(function (isAdmin) {
      state.isAdmin = !!isAdmin
      if (state.open) render()
    })
    if (window.MutationObserver) {
      new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          if (mutations[i].addedNodes && mutations[i].addedNodes.length) {
            ensure()
            return
          }
        }
        ensure()
      }).observe(document.body, { childList: true, subtree: false })
      guardPlaceholders()
    }
    setInterval(ensure, 700)
  }

  window.__emtTickets = {
    state: state,
    open: openDrawer,
    close: closeDrawer,
    refresh: refreshList,
    send: sendMessage,
    render: render,
    apiBase: function () { return state.apiBase },
    _relTime: relTime,
    _statusLabel: statusLabel,
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()
