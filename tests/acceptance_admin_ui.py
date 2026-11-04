import json, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
SITE="http://127.0.0.1:8648"; CHROME="/root/.hermes/tools/chromium-1208/chrome-linux64/chrome"
EVID=Path("/root/work/lyra_desk/evidence")
def creds():
    env={}
    for line in open('/root/.credentials/server.env', encoding='utf-8'):
        line=line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k,v=line.split('=',1); env[k.strip()]=v.strip().strip('"').strip("'")
    return env
def login(u,p):
    req=urllib.request.Request(SITE+'/api/auth/login', data=json.dumps({'username':u,'password':p}).encode(), headers={'content-type':'application/json'})
    with urllib.request.urlopen(req, timeout=15) as r: return json.loads(r.read())['token']
def dismiss(pg):
    # 原生公告弹窗的 mask 会挡住我们抽屉上的按钮（我们 z-index 故意低于它）
    for _ in range(4):
        loc=pg.locator('.n-modal-container button:has-text("Got it")')
        if loc.count()==0:
            # 还有 mask 时直接点 mask
            mask=pg.locator('.n-modal-mask')
            if mask.count()==0: return
            try: mask.first.click(timeout=1500)
            except Exception: return
            pg.wait_for_timeout(300); continue
        try: loc.first.click(timeout=2000)
        except Exception: return
        pg.wait_for_timeout(300)
e=creds()
results=[]
def rec(name, ok, detail):
    results.append(ok); print(('PASS ' if ok else 'FAIL ')+name+' :: '+detail, flush=True)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path=CHROME, args=['--no-sandbox','--disable-dev-shm-usage'])
    for label,u,pw in [('admin',e['EKKO_STUDIO_USER'],e['EKKO_STUDIO_PASSWORD']),('yezi',e['EKKO_YEZI_USER'],e['EKKO_YEZI_PASSWORD'])]:
        tok=login(u,pw)
        ctx=b.new_context(viewport={'width':1440,'height':1000}); pg=ctx.new_page(); pg.set_default_timeout(25000)
        pg.goto(SITE+'/', wait_until='domcontentloaded')
        pg.evaluate("t => localStorage.setItem('hermes_api_key', t)", tok)
        pg.goto(SITE+'/', wait_until='domcontentloaded')
        pg.wait_for_timeout(2500); dismiss(pg)
        dismiss(pg); pg.locator('#ld-tickets-fab').click()
        pg.wait_for_selector('#ld-tickets-drawer.ld-open', timeout=10000)
        pg.wait_for_timeout(2000)
        st=pg.evaluate("() => JSON.stringify({admin: window.__emtTickets.state.isAdmin, n: window.__emtTickets.state.tickets.length, err: window.__emtTickets.state.error, open: window.__emtTickets.state.open, view: window.__emtTickets.state.view})")
        print('DBG', label, st, flush=True)
        seg=pg.locator('.ld-seg button').count()
        rec(f'9a {label} 管理员分段', seg==2, f'seg_buttons={seg}')
        # 全部工单
        dismiss(pg); pg.locator('[data-act="scope-all"]').click()
        pg.wait_for_timeout(1800)
        n=pg.locator('.ld-card').count(); tags=pg.locator('.ld-user-tag').count()
        rec(f'9b {label} 全部工单列出所有人', n>=1 and tags==n, f'cards={n} user_tags={tags}')
        pg.screenshot(path=str(EVID/f'9-admin-all-tickets-{label}.png'))
        dismiss(pg); pg.locator('.ld-card').first.click()
        pg.wait_for_selector('.ld-msg', timeout=15000); pg.wait_for_timeout(800)
        composer=pg.locator('.ld-composer').count(); hint=pg.locator('.ld-body .ld-hint').count()
        rec(f'9c {label} 只读视图不可代答', composer==0, f'composer={composer} hints={hint}')
        pg.screenshot(path=str(EVID/f'9-admin-readonly-{label}.png'))
        # 回到列表再切回「我的」（详情态没有分段开关，这是设计如此）
        dismiss(pg); pg.locator('[data-act="back"]').click()
        pg.wait_for_timeout(1200)
        dismiss(pg); pg.locator('[data-act="scope-mine"]').click()
        pg.wait_for_timeout(1500)
        if pg.locator('.ld-card').count():
            dismiss(pg); pg.locator('.ld-card').first.click()
            pg.wait_for_selector('.ld-msg', timeout=15000); pg.wait_for_timeout(600)
            before=pg.locator('.ld-composer').count()
            toggle=pg.locator('[data-act="toggle-status"]')
            rec(f'9d {label} 有输入框', before==1, f'composer={before} label={toggle.inner_text()!r}')
            toggle.click(); pg.wait_for_timeout(1500)
            after=pg.locator('.ld-composer').count()
            rec(f'9e {label} 关闭后隐藏输入框', after==0, f'composer={after} label={toggle.inner_text()!r}')
            pg.screenshot(path=str(EVID/f'9-closed-{label}.png'))
            dismiss(pg)
            pg.locator('[data-act="toggle-status"]').click()
            pg.wait_for_timeout(1500)
            reopened=pg.locator('.ld-composer').count()
            rec(f'9f {label} 重开后输入框回来', reopened==1, f'composer={reopened}')
        ctx.close()
    b.close()
print(f"\n{sum(results)}/{len(results)} passed")
