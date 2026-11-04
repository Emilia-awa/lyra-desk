# Lyra Desk · 工单侧车

Lyra Studio（Ekko Studio 的自托管魔改版）内置的 AI 工单系统。用户在 Studio 里提问题、报 bug、
提需求，一个**独立的 Hermes profile** 负责查阅代码、翻日志、必要时直接改掉、再验证一遍，
然后带着读数答复。

## 为什么单独一个 profile

工单对话**不能污染主 agent 的上下文**。所以：

- AI 端是独立的 Hermes profile（本仓库不含它的配置），`memory.provider: none`，
  不接任何聊天平台，只暴露 loopback 的 OpenAI 兼容 api_server
- 会话落在那个 profile 自己的 `state.db`
- 本侧车有自己的 SQLite（`data/tickets.db`），不碰 Studio 的业务库

## 结构

```
server/
  index.mjs    HTTP 路由（node:http，零依赖）
  db.mjs       node:sqlite，tickets / ticket_messages 两张表 + 迁移
  auth.mjs     拿 Bearer JWT 去问 Studio /api/auth/me（60s 缓存）
  hermes.mjs   调 api_server；X-Hermes-Session-Id 保持会话连续
web/
  emt-tickets.js   纯 DOM 注入的前端（不改 Studio 任何原生 chunk）
  emt-tickets.css
deploy/
  install.sh                     幂等部署：unit + 静态资源 + index.html 两行注入
  lyra-desk-tickets.service      systemd
tests/
  *.test.mjs                     单测/接口测（桩上游，不碰生产库）
  acceptance_*.py               Playwright 端到端
  emkia_accept.py               独立验收（打真接口 + 查真库 + 越权）
```

## 部署

```bash
bash deploy/install.sh
```

需要一份 `.env`（600）：

```
LD_HOST=127.0.0.1
LD_PORT=8653
LD_DB_PATH=/root/work/lyra_desk/data/tickets.db
LD_STUDIO_BASE=http://127.0.0.1:8648
LD_HERMES_URL=http://127.0.0.1:8643
API_SERVER_KEY=<lyra-desk profile 的 api_server key>
```

反代（nginx）：

```nginx
location /tickets-api/ {
    proxy_pass http://127.0.0.1:8653/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    # 工单 AI 会真跑工具，一轮可到几分钟
    proxy_read_timeout 620s;
    client_max_body_size 8m;
}
```

## 状态模型

`pending`（待进行）→ `in_progress`（正在进行）→ `done`（已完成）。

AI 只有在**确实改完并验证过**之后才会在回答里输出 `[[status:done]]`，侧车解析后剥掉这一行
并把工单置为已完成。

## 已知边界

- 只接受 loopback 绑定；鉴权靠 Studio 的 JWT
- 前端是注入层，Studio 升级会覆盖 `index.html`，需要重跑 `deploy/install.sh`
- 对话不保留跨工单记忆

## 许可

MIT
