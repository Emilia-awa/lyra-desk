# REQ R2：工单系统加「进度 / 状态」+ 界面重做 + 放开联网搜索

## 现状

工单系统（T1）已上线：侧车 `/root/work/lyra_desk/`（8653），前端注入层
`dist/client/assets/js/emt-tickets.js` + `assets/css/emt-tickets.css`，
独立库 `/root/work/lyra_desk/data/tickets.db`，AI 后端是 Hermes profile `lyra-desk`（8643）。

用户反馈三条：

1. **页面太简陋**，要重做。
2. **没有进度条**，要能看出「待进行 / 正在进行 / 已完成」。
3. 要确认**能不能联网搜索**（已实测：API server 的 toolset 里 web 是开的，`web_search`
   能真搜到东西并返回正确 URL。**不要再改这块，只需在提示里明确允许它用**）。

## 一、状态模型（后端 + 迁移）

`tickets.status` 现在是 `open | answered | closed`。改成三态，语义即进度条三段：

| 新值 | 显示 | 含义 |
|---|---|---|
| `pending` | 待进行 | 刚建单，AI 还没答 / 用户刚提了新问题 |
| `in_progress` | 正在进行 | AI 已答复，等用户确认或继续追问 |
| `done` | 已完成 | 已解决（用户点了完成，或 AI 判断已修复） |

**迁移**（幂等，服务启动时跑）：

- `open` → `pending`
- `answered` → `in_progress`
- `closed` → `done`

加一列 `resolved_at INTEGER NOT NULL DEFAULT 0`（done 时写入毫秒时间戳）。

**状态转移规则**

- `POST /api/tickets` 建单 → `pending`
- AI 答题开始前 → `in_progress`（先落状态再调模型，前端能看到「正在进行」）
- AI 答完 → 保持 `in_progress`
- `POST /api/tickets/:id/done` → `done` + `resolved_at`（用户点「标记完成」）
- `POST /api/tickets/:id/reopen` → `in_progress` + `resolved_at=0`（已完成/已关闭都能重开）
- `done` 状态下再发消息 → 400，提示「工单已完成，请先重新打开」
- 管理员接口 `GET /api/admin/tickets` 返回 `status` 与 `resolved_at` 原样

**AI 主动置为已完成**：允许 AI 在回答末尾用一行独立标记控制状态，形如

```
[[status:done]]
```

侧车解析后**剥掉这一行**再落库（用户看不到标记），并把工单置 `done`。
唯一合法值是 `done`；其它值忽略并原样保留在正文里。AI 只有在**确实验证过已修好**时才该用，
这一点写进系统提示。副作用：不允许通过标记把 done 改回 pending。

## 二、前端重做（`emt-tickets.js` / `emt-tickets.css`）

只说必须达成的点，具体视觉你自己拿主意，但**必须看起来不像半成品**。

### 抽屉骨架
- 顶部：标题「我的工单」+ 右上关闭；管理员多一个「全部工单 / 我的」分段控件
- **状态筛选条**：全部 / 待进行 / 正在进行 / 已完成，带各自数量角标
- 列表 + 底部主按钮「＋ 新建工单」
- 列表项：标题、状态胶囊（三色）、最后一条消息两行摘要、相对时间、消息条数
- 空状态要有插画式留白文案（纯 CSS/SVG，别引外部资源）
- 加载态用骨架屏（3 个灰条），不要只写「加载中」

### 详情页
- **顶部三段进度条（stepper）**：`待进行 ─── 正在进行 ─── 已完成`
  - 当前段高亮 + 已完成段打勾，未到达段灰
  - 段与段之间是连接线，已走过的线段着色
  - 每条工单详情顶部常驻，宽度撑满
- 消息气泡：用户右侧（主色）、助手左侧（浅底），时间戳小字
- 「正在进行」时输入框上方有一条细的流动进度条（纯 CSS 动画，不要 JS 计时器造假进度）
- 底部操作：`标记完成` / `重新打开`（按状态切换）+ 输入框 + 发送
- 发送中显示打字指示（三点跳动）

### 液态玻璃
用户明确说现在的按钮「不是液态玻璃」。**工单抽屉与 FAB 全部改用液态玻璃质感**：
`backdrop-filter: blur(18px) saturate(160%)` + 半透明底 + 1px 内高光边 + 柔和外阴影。
必须同时写 `-webkit-backdrop-filter`。不支持 `backdrop-filter` 时降级为不透明底（用
`@supports not (backdrop-filter: blur(1px))`）。

### FAB 不能挡发送键（用户报过）
现 FAB 是 `right:0; top:38%` 竖排。改为：
- 桌面：`right: 14px; bottom: 96px`，圆形 52px，液态玻璃，图标 + hover 展开文字
- ≤768px：`right: 14px; bottom: calc(84px + env(safe-area-inset-bottom))`，48px 圆
- **绝不允许压住聊天输入区**：`z-index` 不高于 800，且 `pointer-events` 只在自己的圆内。
  右侧聊天输入框区域（`bottom: 0` 到 `bottom: 140px`）不得被任何工单元素覆盖 —— 用
  `right:14px` 的窄条，宽度 ≤ 56px。

### 主题
跟随 Studio 明暗主题（读 `<html>` / `body` 上的 class 或 `data-theme`，自己探一下现有注入层怎么判的，
`emt-agent-cards.js` 里有现成写法）。**不许硬编码背景色**，用 CSS 变量加 fallback。

## 三、系统提示（`server/hermes.mjs` 的 `SYSTEM_PROMPT`）

在现有提示基础上补三条，别推翻重写：

1. **明确允许联网搜索**：`web_search` / `web_extract` 可用，遇到不熟悉的技术细节、版本差异、
   第三方库行为，先搜再答，并在回答里点明「查了 X」。
2. **允许用 `[[status:done]]`**：只有在你**实际改完并验证过**（真开浏览器 / curl 真返回）
   之后才加这一行；只是给出建议、没动手改的，一律不加。
3. 修完东西要说明「改了哪个文件、验证读数是什么」。

## 四、验收（每条必须有实际输出，写进 REPORT.md）

1. `curl 8653/api/health` → `{"ok":true,"ai":true}`
2. 老数据迁移：迁移前后各打一次 `select status, count(*) from tickets group by status`，
   `open/answered/closed` 必须清零
3. 建单 → 取详情 → `status` 为 `in_progress` 且 `resolved_at=0`
4. `POST /done` → `status=done` 且 `resolved_at>0`；此时再发消息 → 400
5. `POST /reopen` → `status=in_progress` 且 `resolved_at=0`
6. AI 返回含 `[[status:done]]` 时：落库正文**不含**该标记，工单状态为 `done`
   （用一个 `[[status:done]]` 的桩上游测，别指望真模型配合）
7. 浏览器真开 `https://211.154.18.252:10172`（自签证书忽略校验）：
   - 抽屉打开，三段进度条渲染，当前段 class 正确
   - 点「标记完成」后进度条第三段高亮 + 打勾，再点「重新打开」回来
   - 列表三种状态胶囊颜色不同
   - 截图落 `/root/work/lyra_desk/evidence/r2/`
8. **FAB 不挡发送键**：390×844 与 1440×900 两个视口，取 FAB 的 `getBoundingClientRect()`
   和聊天输入框容器的 rect，**两个矩形不许相交**，把两个 rect 打印出来
9. `backdrop-filter` 生效：读 FAB 的 `getComputedStyle().backdropFilter`，非 `none`
10. 主题：明暗两套各截一张，文字不能看不见（判据：把抽屉整体截图，主文字与背景
   对比度自己目测说清，别只写「正常」）

## 不许做的事

- 不改 `dist/server/index.js`，不改任何原生前端 chunk
- 不动 `hermes-web-ui.db`
- 不删已有工单数据（只做状态映射）
- 不把 API key 写进前端 / 日志 / git

## 报告

`/root/work/lyra_desk/REPORT_R2.md`：改了什么、验收 10 条逐条带真实输出、已知限制。
