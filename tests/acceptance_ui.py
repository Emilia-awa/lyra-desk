#!/usr/bin/env python3
"""浏览器验收（REQ 第 7、8 条）—— Playwright 真开 http://127.0.0.1:8648。

7. 点「工单」按钮 → 抽屉出现 → 建单 → 收到回答 → 刷新后工单还在（截图）
8. 390×844 手机视口：抽屉不溢出、输入框在可视区内（100dvh，截图）

token 通过 localStorage.hermes_api_key 注入（与 emt_agents 的 UI 测试一致）。
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

SITE = "http://127.0.0.1:8648"
EVIDENCE = Path("/root/work/lyra_desk/evidence")
CHROME = "/root/.hermes/tools/chromium-1208/chrome-linux64/chrome"
CREDS = "/root/.credentials/server.env"


def credentials() -> dict:
    env = {}
    for line in open(CREDS, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def login() -> str:
    env = credentials()
    req = urllib.request.Request(
        SITE + "/api/auth/login",
        data=json.dumps({"username": env["EKKO_STUDIO_USER"], "password": env["EKKO_STUDIO_PASSWORD"]}).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())["token"]


def dismiss_notice(page) -> None:
    for _ in range(3):
        loc = page.locator('.n-modal-container button:has-text("Got it")')
        if loc.count() == 0:
            return
        try:
            loc.first.click(timeout=2000)
        except Exception:
            return
        page.wait_for_timeout(300)


def shot(page, name: str) -> str:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    path = EVIDENCE / name
    page.screenshot(path=str(path))
    return str(path)


def main() -> int:
    results: list[tuple[str, bool, str]] = []

    def record(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + " :: " + detail, flush=True)

    token = login()
    print("[login] ok", flush=True)
    title = f"浏览器验收-{int(time.time())}"

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox", "--disable-dev-shm-usage"])

        # ---------------- 7. 桌面 ----------------
        ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = ctx.new_page()
        page.set_default_timeout(30000)
        page.goto(SITE + "/", wait_until="domcontentloaded")
        page.evaluate("t => localStorage.setItem('hermes_api_key', t)", token)
        page.goto(SITE + "/", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        dismiss_notice(page)

        fab = page.locator("#ld-tickets-fab")
        fab.wait_for(state="visible", timeout=20000)
        box = fab.bounding_box() or {}
        record("7a 竖排按钮就位",
               bool(box) and abs((box["x"] + box["width"]) - 1440) < 2,
               f"box={json.dumps(box)}")

        fab.click()
        drawer = page.locator("#ld-tickets-drawer.ld-open")
        drawer.wait_for(state="visible", timeout=10000)
        page.wait_for_timeout(1200)
        dbox = drawer.bounding_box() or {}
        record("7b 抽屉打开 420px 贴右",
               bool(dbox) and abs(dbox["width"] - 420) < 2 and abs((dbox["x"] + dbox["width"]) - 1440) < 2,
               f"box={json.dumps(dbox)}")
        shot(page, "7-1-drawer-list.png")

        # 新建工单
        page.locator('[data-act="new"]').click()
        page.locator('[data-field="title"]').fill(title)
        page.locator('[data-field="body"]').fill(
            "手机上打开 Lyra 后底部导航挡住了输入框，打字时看不到自己输入的内容。想确认有没有办法临时绕过。"
        )
        page.locator('[data-act="submit-ticket"]').click()
        page.wait_for_selector(".ld-msg.ld-assistant .ld-bubble", timeout=120000)
        page.wait_for_timeout(500)
        reply = page.locator(".ld-msg.ld-assistant .ld-bubble").last.inner_text()
        record("7c 建单收到回答", len(reply.strip()) > 20 and "失败" not in reply[:8],
               f"reply_len={len(reply)} reply={reply[:100]!r}")
        shot(page, "7-2-drawer-detail-answer.png")

        # 刷新后仍在
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        dismiss_notice(page)
        page.locator("#ld-tickets-fab").click()
        page.wait_for_selector("#ld-tickets-drawer.ld-open", timeout=10000)
        page.wait_for_timeout(1500)
        card = page.locator(".ld-card", has_text=title).first
        card.wait_for(state="visible", timeout=15000)
        record("7d 刷新后工单还在", True, f"title={title}")
        shot(page, "7-3-after-reload.png")

        # 打开详情看历史消息
        card.click()
        page.wait_for_selector(".ld-msg", timeout=15000)
        page.wait_for_timeout(800)
        n_msgs = page.locator(".ld-msg").count()
        record("7e 详情含历史消息", n_msgs >= 2, f"messages={n_msgs}")
        shot(page, "7-4-detail-history.png")
        ctx.close()

        # ---------------- 8. 手机 390×844 ----------------
        mctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        mpage = mctx.new_page()
        mpage.set_default_timeout(30000)
        mpage.goto(SITE + "/", wait_until="domcontentloaded")
        mpage.evaluate("t => localStorage.setItem('hermes_api_key', t)", token)
        mpage.goto(SITE + "/", wait_until="domcontentloaded")
        mpage.wait_for_timeout(2500)
        dismiss_notice(mpage)
        mpage.locator("#ld-tickets-fab").click()
        mpage.wait_for_selector("#ld-tickets-drawer.ld-open", timeout=15000)
        mpage.wait_for_timeout(1500)
        mpage.locator(".ld-card", has_text=title).first.click()
        mpage.wait_for_selector(".ld-msg", timeout=15000)
        mpage.wait_for_timeout(1000)

        metrics = mpage.evaluate("""() => {
          const d = document.getElementById('ld-tickets-drawer');
          const r = d.getBoundingClientRect();
          const ta = document.querySelector('.ld-composer textarea');
          const tr = ta ? ta.getBoundingClientRect() : null;
          return {
            docScrollW: document.documentElement.scrollWidth,
            innerW: window.innerWidth,
            innerH: window.innerHeight,
            drawer: { x: r.x, y: r.y, w: r.width, h: r.height },
            textarea: tr ? { x: tr.x, y: tr.y, w: tr.width, h: tr.height, bottom: tr.bottom } : null,
            bodyOverflowX: document.body.scrollWidth - window.innerWidth,
            dvh: getComputedStyle(d).height,
          }
        }""")
        ok8 = (
            metrics["docScrollW"] <= metrics["innerW"] + 1
            and metrics["drawer"]["w"] <= 391
            and metrics["drawer"]["h"] <= metrics["innerH"] + 1
            and metrics["textarea"] is not None
            and metrics["textarea"]["bottom"] <= metrics["innerH"] + 1
        )
        record("8 390×844 不溢出、输入框可见", ok8, json.dumps(metrics, ensure_ascii=False))
        shot(mpage, "8-1-mobile-390x844.png")

        # 手机上发一条，确认能滚到底、键盘区不挡（用 focus 模拟）
        mpage.locator('[data-field="message"]').focus()
        mpage.wait_for_timeout(900)
        ph = mpage.locator('[data-field="message"]').get_attribute("placeholder")
        record("8b 移动端 placeholder 未被 emt-mobile.js 覆盖", ph == "继续追问…", f"placeholder={ph!r}")
        shot(mpage, "8-2-mobile-composer.png")
        mctx.close()
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
