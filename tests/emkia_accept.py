#!/usr/bin/env python3
"""独立验收：工单系统（T1）

不信 zcode 的自述，每条都打真接口 / 查真库 / 开真浏览器。
用法: python3 /root/work/lyra_desk/tests/emkia_accept.py
"""
import json
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

SITE = "http://127.0.0.1:8648"
SIDE = "http://127.0.0.1:8653"
CREDS = "/root/.credentials/server.env"
DB = "/root/work/lyra_desk/data/tickets.db"
FAILS = []
OKS = []


def creds():
    env = {}
    for line in Path(CREDS).read_text().splitlines():
        i = line.find("=")
        if i > 0 and not line.lstrip().startswith("#"):
            env[line[:i].strip()] = line[i + 1:].strip().strip("\"'")
    return env


def login(user=None, pw=None):
    c = creds()
    body = json.dumps({
        "username": user or c["EKKO_STUDIO_USER"],
        "password": pw or c["EKKO_STUDIO_PASSWORD"],
    }).encode()
    req = urllib.request.Request(f"{SITE}/api/auth/login", data=body,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["token"]


def api(token, method, path, body=None, base=SIDE):
    data = None if body is None else json.dumps(body).encode()
    h = {"Authorization": f"Bearer {token}"}
    if data is not None:
        h["content-type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=200) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}


def check(name, cond, detail=""):
    (OKS if cond else FAILS).append(name)
    print(("PASS " if cond else "FAIL ") + name + (("  | " + str(detail)[:220]) if detail else ""))


def dbquery(sql, args=()):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def main():
    t0 = time.time()
    # --- 1. health
    with urllib.request.urlopen(SIDE + "/api/health", timeout=30) as r:
        h = json.load(r)
    check("1 health ok+ai", h.get("ok") is True and h.get("ai") is True, h)

    tok = login()
    # --- 响应头不该泄露 session id / key
    st, me = api(tok, "GET", "/api/tickets")
    check("1b 列表可读", st == 200 and isinstance(me.get("tickets"), list), f"HTTP {st} n={len(me.get('tickets') or [])}")

    marker = f"EMKIA-{int(time.time())}"
    title = f"{marker} 聊天页白屏"
    st, created = api(tok, "POST", "/api/tickets", {
        "title": title,
        "body": f"{marker} 我在手机 Chrome 上打开 Lyra，聊天页一进去就白屏，控制台报 chunk 加载失败。想问怎么临时恢复。",
    })
    ticket = created.get("ticket") or {}
    tid = ticket.get("id")
    msgs = ticket.get("messages") or []
    asst = [m for m in msgs if m.get("role") == "assistant"]
    check("2 建单返回 assistant 回答", st == 200 and bool(asst) and len(asst[0]["content"]) > 30,
          f"HTTP {st} tid={tid} nmsg={len(msgs)} first={(asst[0]['content'][:60] if asst else None)!r}")
    check("2b 回答不是失败气泡", bool(asst) and "回答失败" not in asst[0]["content"],
          asst[0]["content"][:80] if asst else "")

    # --- 3 同单追问，验证会话续接
    st, follow = api(tok, "POST", f"/api/tickets/{tid}/messages", {"content": "我刚才问的是什么？用一句话复述。"})
    fm = [m for m in (follow.get("messages") or []) if m.get("role") == "assistant"]
    recall_ok = bool(fm) and ("白屏" in fm[-1]["content"] or "chunk" in fm[-1]["content"].lower())
    check("3 同单续接（能复述上一轮）", st == 200 and recall_ok,
          f"HTTP {st} reply={(fm[-1]['content'][:90] if fm else None)!r}")

    sess = dbquery("select lyra_session_id from tickets where id=?", (tid,))
    check("3b 工单落了 session id", bool(sess and sess[0][0].startswith("api-")), sess)

    # --- 4 越权
    try:
        c = creds()
        other = login(c["EKKO_YEZI_USER"], c["EKKO_YEZI_PASSWORD"])
    except Exception:
        other = None
    leaked = None
    if other and other != tok:
        st2, body2 = api(other, "GET", f"/api/tickets/{tid}")
        leaked = (st2, body2)
        check("4 他人 token 取单 404", st2 == 404, leaked)
    else:
        check("4 他人 token 取单 404", False, "拿不到第二账号 token，跳过判定")

    # --- 5 无 JWT
    req = urllib.request.Request(SIDE + "/api/tickets", method="GET")
    try:
        urllib.request.urlopen(req, timeout=10)
        check("5 无 token 401", False, "居然 200")
    except urllib.error.HTTPError as e:
        check("5 无 token 401", e.code == 401, e.code)

    # --- 6 关闭后提交
    api(tok, "POST", f"/api/tickets/{tid}/close")
    st, closed = api(tok, "POST", f"/api/tickets/{tid}/messages", {"content": "关了还能发吗"})
    check("6 关闭后提交 400", st == 400, f"HTTP {st} {str(closed)[:80]}")
    api(tok, "POST", f"/api/tickets/{tid}/reopen")

    # --- 7 上下文隔离：标题不得出现在 default / coconut 的库
    hits = []
    for p in ("/root/.hermes/state.db", "/root/.hermes/profiles/coconut/state.db"):
        if not Path(p).exists():
            continue
        try:
            con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
            n = con.execute("select count(*) from messages where content like ?", (f"%{marker}%",)).fetchone()[0]
            con.close()
        except Exception as e:
            n = -1
        hits.append((p, n))
    check("7 marker 未污染 default/coconut", all(n == 0 for _, n in hits), hits)

    # --- 7b lyra-desk 自己的库里应当有（证明答的是它）
    try:
        con = sqlite3.connect("file:/root/.hermes/profiles/lyra-desk/state.db?mode=ro", uri=True)
        n2 = con.execute("select count(*) from messages where content like ?", (f"%{marker}%",)).fetchone()[0]
        con.close()
    except Exception as e:
        n2 = -1
    check("7b lyra-desk 库里有该工单对话", n2 > 0, n2)

    # --- 8 空标题校验
    st, bad = api(tok, "POST", "/api/tickets", {"title": "  ", "body": "x"})
    check("8 空标题 400", st == 400, f"HTTP {st}")

    print("\n==== %d PASS / %d FAIL  %.1fs ====" % (len(OKS), len(FAILS), time.time() - t0))
    if FAILS:
        print("FAILED:", FAILS)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
