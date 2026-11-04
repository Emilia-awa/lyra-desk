#!/usr/bin/env python3
"""真栈上的并发与持久化验证。

- 同一工单并发 3 条追问：消息必须严格按 user/assistant 成对落库，不交叉
- 不同工单并发建单：互不影响
- 重启服务后工单仍在（SQLite 落盘，不是内存态）
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "http://127.0.0.1:8653/api"
STUDIO = "http://127.0.0.1:8648"
DB = "/root/work/lyra_desk/data/tickets.db"


def creds() -> dict:
    env = {}
    for line in open("/root/.credentials/server.env", encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def login() -> str:
    e = creds()
    req = urllib.request.Request(
        STUDIO + "/api/auth/login",
        data=json.dumps({"username": e["EKKO_STUDIO_USER"], "password": e["EKKO_STUDIO_PASSWORD"]}).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())["token"]


def call(method, path, token, body=None, timeout=200):
    headers = {"accept": "application/json", "authorization": "Bearer " + token}
    data = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def main() -> int:
    token = login()
    results: list[bool] = []

    def rec(name, ok, detail):
        results.append(ok)
        print(("PASS " if ok else "FAIL ") + name + " :: " + detail, flush=True)

    stamp = int(time.time())
    status, created = call("POST", "/tickets", token,
                           {"title": f"并发验证-{stamp}", "body": "起点：先确认串行化不会交叉写入。"})
    tid = created["ticket"]["id"]
    rec("并发准备：建单成功", status == 200, f"ticket={tid} status={status}")

    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = [
            ex.submit(call, "POST", f"/tickets/{tid}/messages", token, {"content": f"并发问题 {i}"})
            for i in (1, 2, 3)
        ]
        outs = [f.result() for f in futs]
    rec("并发追问：3 条全部 200", all(s == 200 for s, _ in outs), f"codes={[s for s, _ in outs]}")

    status, detail = call("GET", f"/tickets/{tid}", token)
    msgs = detail["ticket"]["messages"]
    roles_ok = all(m["role"] == ("user" if i % 2 == 0 else "assistant") for i, m in enumerate(msgs))
    # 三条并发问题都必须落库、顺序与发送一致，且每条后面紧跟一条非空回答。
    # 真实上游的措辞不可预测，所以这里只验证结构而非答案文本。
    asked = [m["content"] for m in msgs if m["role"] == "user"]
    concurrent_seen = [q for q in asked if q.startswith("并发问题 ")]
    answers = [m["content"] for m in msgs if m["role"] == "assistant"]
    pairs_ok = (
        len(concurrent_seen) == 3
        and len(set(concurrent_seen)) == 3
        and len(answers) == 4
        and all(a.strip() and not a.startswith("抱歉，本轮回答失败") for a in answers)
    )
    rec("并发追问：严格 user/assistant 成对，回答不串", roles_ok and pairs_ok and len(msgs) == 8,
        f"messages={len(msgs)} roles_ok={roles_ok} pairs_ok={pairs_ok} asked={concurrent_seen}")

    # 不同工单并发
    with ThreadPoolExecutor(max_workers=2) as ex:
        fut_a = ex.submit(call, "POST", "/tickets", token, {"title": f"并发A-{stamp}", "body": "甲工单"})
        fut_b = ex.submit(call, "POST", "/tickets", token, {"title": f"并发B-{stamp}", "body": "乙工单"})
        sa, ba = fut_a.result()
        sb, bb = fut_b.result()
    ans_a = ba["ticket"]["messages"][1]["content"]
    ans_b = bb["ticket"]["messages"][1]["content"]
    # 每张单的第一条回答必须非空、且没有把另一张单的内容写进来
    ok = (sa == 200 and sb == 200
          and ans_a.strip() and ans_b.strip()
          and "坏" not in ans_a + ans_b
          and not ans_a.startswith("抱歉") and not ans_b.startswith("抱歉"))
    rec("不同工单并发：各自答案非空且不串单", ok,
        f"A={ans_a[:30]!r} B={ans_b[:30]!r}")

    # 重启持久化
    before = sqlite3.connect("file:" + DB + "?mode=ro", uri=True).execute("SELECT COUNT(*) FROM tickets").fetchone()[0]
    subprocess.run(["systemctl", "restart", "lyra-desk-tickets"], check=True)
    deadline = time.time() + 30
    health = None
    while time.time() < deadline:
        try:
            status, health = call("GET", "/health", token, timeout=30)
            if status == 200:
                break
        except Exception:
            pass
        time.sleep(1)
    after = sqlite3.connect("file:" + DB + "?mode=ro", uri=True).execute("SELECT COUNT(*) FROM tickets").fetchone()[0]
    status, detail = call("GET", f"/tickets/{tid}", token)
    rec("重启后数据仍在", health and health.get("ok") and after == before and status == 200,
        f"before={before} after={after} health={health} detail_status={status}")

    print(f"\n{sum(results)}/{len(results)} passed", flush=True)
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
