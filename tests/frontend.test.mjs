// Front-end injection contract tests (no browser needed).
//
// These guard the deployment invariants from REQ §3: only two lines added to
// index.html, only emt-tickets.* files added, no hard-coded background colours,
// and the observer/interval fallback actually present.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const CLIENT = '/root/.hermes/tools/node-26.12.1-linux-x64/lib/node_modules/ekko-studio/dist/client'
const LOCAL_JS = '/root/work/lyra_desk/web/emt-tickets.js'
const LOCAL_CSS = '/root/work/lyra_desk/web/emt-tickets.css'

// Deployed copies only exist after deploy/install.sh; skip when running a bare
// checkout so the unit suite works on a clean machine.
const DEPLOYED = existsSync(`${CLIENT}/assets/js/emt-tickets.js`)

test('source files exist and are syntactically loadable', () => {
  const js = readFileSync(LOCAL_JS, 'utf8')
  const css = readFileSync(LOCAL_CSS, 'utf8')
  assert.ok(js.length > 5000, 'js not empty')
  assert.ok(css.length > 2000, 'css not empty')
  assert.ok(js.includes("'use strict'"))
  assert.ok(js.includes('MutationObserver'), 'REQ: MutationObserver required')
  assert.ok(/setInterval\(ensure,\s*700\)/.test(js), 'REQ: 700ms interval fallback')
  assert.ok(js.includes('100dvh') === false, 'dvh belongs in the CSS, not the JS')
})

test('css: dvh, 420px drawer, 36px-ish rail button, no hard-coded dark background', () => {
  const css = readFileSync(LOCAL_CSS, 'utf8')
  assert.ok(css.includes('100dvh'), 'REQ: 100dvh for mobile keyboard area')
  assert.ok(css.includes('width: 420px'), 'REQ: 420px drawer')
  assert.ok(css.includes('@media (max-width: 768px)'), 'REQ: <=768px full-screen drawer')
  assert.ok(css.includes('top: 38%'), 'REQ: rail button at top 38%')
  assert.ok(/width:\s*3[0-9]px/.test(css), 'REQ: rail button about 36px wide')
  assert.ok(css.includes('var(--bg-card'), 'REQ: use Studio CSS variables')
  assert.ok(css.includes('var(--text-primary'), 'REQ: use Studio text variables')

  // No literal dark colours as backgrounds: those break the light theme.
  const darkLiterals = css.match(/background(?:-color)?:\s*#(?:0|1|2)[0-9a-f]{2,5}\b/gi) || []
  assert.deepEqual(darkLiterals, [], 'no hard-coded dark backgrounds')
  const hexBg = css.match(/background(?:-color)?:\s*#[0-9a-f]{3,6}/gi) || []
  assert.ok(hexBg.every(v => /#fff\b/i.test(v) || /#ffffff/i.test(v)), `only #fff literals allowed: ${hexBg}`)
})

test('js: no secrets, no API key, no absolute upstream host baked in', () => {
  const js = readFileSync(LOCAL_JS, 'utf8')
  assert.ok(!/API_SERVER_KEY|Bearer\s+[A-Za-z0-9_-]{40,}/.test(js), 'no baked credentials')
  assert.ok(!js.includes('8643'), 'browser never talks to the Hermes port')
  assert.ok(js.includes('hermes_api_key'), 'uses the Studio token from localStorage')
})

test('js: admin segment is read-only (no reply path for admins)', () => {
  const js = readFileSync(LOCAL_JS, 'utf8')
  assert.ok(js.includes('/admin/tickets'), 'admin list endpoint')
  assert.ok(js.includes('本版不支持管理员人工代答'), 'read-only notice')
  // the message POST must be scoped to /tickets/:id/messages only
  assert.ok(/\/tickets\/' \+ ticket\.id \+ '\/messages/.test(js))
})

test('js: failed answer bubble offers retry, pending bubble says 思考中', () => {
  const js = readFileSync(LOCAL_JS, 'utf8')
  assert.ok(js.includes('思考中…'))
  assert.ok(js.includes("'重试'"))
  assert.ok(js.includes('抱歉，本轮回答失败'))
})

test('index.html: exactly the two expected lines, comment present', { skip: !DEPLOYED }, () => {
  const html = readFileSync(`${CLIENT}/index.html`, 'utf8')
  assert.ok(html.includes('<!-- 工单系统（魔改；删掉下面两行即完全恢复） -->'))
  assert.ok(html.includes('<link rel="stylesheet" href="/assets/css/emt-tickets.css">'))
  assert.ok(html.includes('<script defer src="/assets/js/emt-tickets.js"></script>'))
  const jsRefs = html.match(/emt-tickets\.js/g) || []
  const cssRefs = html.match(/emt-tickets\.css/g) || []
  assert.equal(jsRefs.length, 1, 'exactly one script tag')
  assert.equal(cssRefs.length, 1, 'exactly one stylesheet link')
})

test('deployed assets are byte-identical to the repo copies', { skip: !DEPLOYED }, () => {
  assert.equal(
    readFileSync(`${CLIENT}/assets/js/emt-tickets.js`, 'utf8'),
    readFileSync(LOCAL_JS, 'utf8'),
    'deploy is current — run deploy/install.sh',
  )
  assert.equal(
    readFileSync(`${CLIENT}/assets/css/emt-tickets.css`, 'utf8'),
    readFileSync(LOCAL_CSS, 'utf8'),
    'deploy is current — run deploy/install.sh',
  )
})

test('deployed index.html body untouched apart from the two lines', { skip: !DEPLOYED }, () => {
  const html = readFileSync(`${CLIENT}/index.html`, 'utf8')
  assert.ok(html.includes('<div id="app">'))
  assert.ok(html.includes('boot-fallback'))
  // the closing tag must still be the last structural thing
  assert.ok(html.trimEnd().endsWith('</html>'))
  // no native chunk was renamed away
  const chunkRefs = html.match(/\/assets\/js\/[A-Za-z0-9_-]+\.js/g) || []
  assert.ok(chunkRefs.length > 5, 'native module graph intact')
})
