#!/usr/bin/env python3
"""在真栈上跑验收 1–6 条（真 Studio token、真 Hermes、真 tickets.db）。

只读 `/root/.credentials/server.env` 取 Studio 账号；不打印 token 与 API key。
"""
from __future__ import annotations

import json
import sqlite3
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:8653/api"
STUDIO = "http://127.0.0.1:8648"
TICKETS_DB = "/root/work/lyra_desk/data/tickets.db"
ISOLATED_DBS = [
    "/root/.hermes/state.db",
    "/root/.hermes/profiles/coconut/state.db",
]


def credentials() -> dict:
    env = {}
    for line in open("/root/.credentials/server.env", encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def login(user: str, password: str) -> str:
    req = urllib.request.Request(
        STUDIO + "/api/auth/login",
        data=json.dumps({"username": user, "password": password}).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())["token"]


def call(method: str, path: str, token: str | None = None, body=None, timeout=200):
    headers = {"accept": "application/json"}
    data = None
    if token:
        headers["authorization"] = "Bearer " + token
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw.decode("utf-8", "replace")}


def db_counts(needle: str, path: str) -> tuple[int, int]:
    """(messages hits, sessions hits) using a read-only URI connection."""
    con = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
    try:
        m = con.execute("SELECT COUNT(*) FROM messages WHERE content LIKE ?", (f"%{needle}%",)).fetchone()[0]
        s = 0
        try:
            s = con.execute("SELECT COUNT(*) FROM sessions WHERE title LIKE ?", (f"%{needle}%",)).fetchone()[0]
        except sqlite3.Error:
            pass
        return m, s
    finally:
        con.close()


def main() -> int:
    env = credentials()
    results: list[tuple[str, bool, str]] = []

    def record(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + " :: " + detail, flush=True)

    # ---- 1 health ----
    status, body = call("GET", "/health")
    record("1 health", status == 200 and body.get("ok") is True and body.get("ai") is True,
           f"status={status} body={json.dumps(body, ensure_ascii=False)}")

    admin = login(env["EKKO_STUDIO_USER"], env["EKKO_STUDIO_PASSWORD"])
    yezi = login(env["EKKO_YEZI_USER"], env["EKKO_YEZI_PASSWORD"])

    title = f"验收-登录转圈-{int(time.time())}"
    needle = f"验收-登录转圈-{title.rsplit('-', 1)[1]}"
    body_text = "我在 Lyra Studio 登录后聊天页一直转圈，刷新也没用。想确认这是前端还是后端的问题。"

    # ---- 2 create + assistant answer ----
    status, created = call("POST", "/tickets", admin, {"title": title, "body": body_text})
    ticket = (created or {}).get("ticket") or {}
    msgs = ticket.get("messages") or []
    assistant = [m for m in msgs if m["role"] == "assistant"]
    reply = assistant[0]["content"] if assistant else ""
    record("2 建单+AI回答",
           status == 200 and len(msgs) == 2 and bool(reply.strip()) and ticket.get("status") == "answered",
           f"status={status} ticketId={ticket.get('id')} status={ticket.get('status')} "
           f"reply_len={len(reply)} reply={reply[:120]!r}")
    tid = ticket.get("id")

    # ---- 3 follow-up proves X-Hermes-Session-Id ----
    status, follow = call("POST", f"/tickets/{tid}/messages", admin, {"content": "刚才我问的是什么？请原样复述我第一条消息的核心内容。"})
    fmsgs = (follow or {}).get("messages") or []
    freply = fmsgs[1]["content"] if len(fmsgs) > 1 else ""
    record("3 会话续接", status == 200 and "转圈" in freply,
           f"status={status} reply={freply[:200]!r}")

    # ---- 4 other user sees 404 ----
    status, other = call("GET", f"/tickets/{tid}", yezi)
    record("4 他人工单 404", status == 404, f"status={status} body={json.dumps(other, ensure_ascii=False)}")

    # ---- 5 isolation scan ----
    detail = []
    ok5 = True
    for path in ISOLATED_DBS:
        m, s = db_counts(needle, path)
        detail.append(f"{path}: messages={m} sessions={s}")
        ok5 = ok5 and m == 0 and s == 0
    con = sqlite3.connect("file:" + TICKETS_DB + "?mode=ro", uri=True)
    try:
        own = con.execute("SELECT COUNT(*) FROM tickets WHERE title LIKE ?", (f"%{needle}%",)).fetchone()[0]
    finally:
        con.close()
    detail.append(f"{TICKETS_DB}: hits={own}")
    record("5 隔离零命中", ok5 and own > 0, " | ".join(detail))

    # ---- 6 closed then submit → 400 ----
    call("POST", f"/tickets/{tid}/close", admin)
    status, closed = call("POST", f"/tickets/{tid}/messages", admin, {"content": "关了还能问吗"})
    record("6 关闭后提交 400", status == 400 and "已关闭" in json.dumps(closed, ensure_ascii=False),
           f"status={status} body={json.dumps(closed, ensure_ascii=False)}")

    # restart for the browser pass: leave the ticket open and seeded
    call("POST", f"/tickets/{tid}/reopen", admin)
    print("\nBROWSER_TICKET_ID=" + str(tid), flush=True)
    print("BROWSER_TICKET_TITLE=" + title, flush=True)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
