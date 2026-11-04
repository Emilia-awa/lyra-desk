import json, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
SITE="http://127.0.0.1:8648"; CHROME="/root/.hermes/tools/chromium-1208/chrome-linux64/chrome"
EV=Path("/root/work/lyra_desk/evidence")
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
e=creds(); tok=login(e['EKKO_STUDIO_USER'], e['EKKO_STUDIO_PASSWORD'])
with sync_playwright() as p:
    b=p.chromium.launch(executable_path=CHROME, args=['--no-sandbox','--disable-dev-shm-usage'])
    for theme,mode in [('dark','dark'),('light','light')]:
        ctx=b.new_context(viewport={'width':1440,'height':1000}, color_scheme=mode)
        pg=ctx.new_page(); pg.set_default_timeout(25000)
        pg.goto(SITE+'/', wait_until='domcontentloaded')
        pg.evaluate("""t => { localStorage.setItem('hermes_api_key', t); localStorage.setItem('hermes_brightness', '%s'); }""" % theme, tok)
        pg.goto(SITE+'/', wait_until='domcontentloaded')
        pg.wait_for_timeout(2500)
        pg.locator('#ld-tickets-fab').click()
        pg.wait_for_selector('#ld-tickets-drawer.ld-open', timeout=15000)
        pg.wait_for_timeout(1500)
        pg.locator('.ld-card').first.click()
        pg.wait_for_selector('.ld-msg', timeout=15000)
        pg.wait_for_timeout(1200)
        colors = pg.evaluate("""() => {
          const d = document.getElementById('ld-tickets-drawer');
          const bub = document.querySelector('.ld-msg.ld-assistant .ld-bubble');
          const cs = getComputedStyle(d), bs = getComputedStyle(bub);
          return {html_dark: document.documentElement.classList.contains('dark'),
                  drawer_bg: cs.backgroundColor, drawer_fg: cs.color,
                  bubble_bg: bs.backgroundColor, bubble_fg: bs.color};
        }""")
        print(theme, json.dumps(colors))
        pg.screenshot(path=str(EV/f'10-theme-{theme}.png'))
        ctx.close()
    b.close()
