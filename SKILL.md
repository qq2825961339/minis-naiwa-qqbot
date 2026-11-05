---
name: minis-naiwa-qqbot
description: 在 iPhone(iSH) 上搭一个叫「奶蛙」的 QQ 机器人，接进 Minis 模型。支持扫码或环境变量两种登录，自动挑选可用模型（优先能看图的），能看图片和 GIF、多轮记忆、像真人一样分条追问；人格放在 persona/ 目录里可换。触发词：奶蛙、QQ 机器人、qq bot、扫码绑定 QQ、龙虾 Bot、agent-qqbot、把 Minis 接到 QQ、给奶蛙换人格。
---

> ## ⛔ 变更约束（最高优先级，必须遵守）
>
> **修改本技能的任何文件之前，必须先取得用户明确同意。**
>
> 1. 收到"改这个技能"的意图时，先说明**要改哪些文件、改什么、为什么**，然后停下来等用户确认。
> 2. 用户没有明确说"同意 / 可以 / 改吧 / 批准"之前，**不得写入、删除、移动**本目录下任何文件（含 `src/`、脚本、文档、配置模板）。
> 3. 用户同意后，改完必须执行 `./guard.sh approve` 重新登记指纹。
> 4. 未经同意**不得**执行 `./guard.sh approve`，也不得删除或改写 `.manifest.sha256`——那是绕过守卫的行为。
>
> 例外（无需同意，但改完要告知）：
> - 运行时数据：`config.json`、`groups.json`、`.state.json`、`.intents.json`、`qqbot.log`、`media/`、`.run.pid`
> - 凭据：`credentials.json`（仅由 `bind.mjs` 写入）
>
> 变更前自查：`./guard.sh verify` —— 返回 ✅ 说明当前状态干净，返回 ❌ 说明有人（或你）动过。

# minis-naiwa-qqbot —— 奶蛙 QQ 机器人

官方文档：https://bot.q.qq.com/wiki/agent-qqbot/ （「第三方 Agent 接入」章节）

## 它做什么

```
QQ 用户 ──消息──> QQ 开放平台 ──WS 网关──> 本技能(run.mjs) ──> Minis Agent ──> 回复回 QQ
```

- **绑定**：官方扫码 SDK 拿 `AppID` + `AppSecret`（等价于开放平台后台手动创建）
- **收消息**：QQ v2 WebSocket 网关（私聊 C2C / 群 @ / 频道 @ / 频道私信），自带心跳、RESUME 续连、指数退避重连
- **intents 自动降级**：扫码创建的机器人默认只有「群 + 私聊」权限（`1<<25`），请求频道 intents 会被平台以 **close 4014 / INVALID_SESSION** 拒绝；`gateway.mjs` 会自动降级到群+私聊再上线
- **处理**：每个会话（私聊按 openid、群按 group_openid、频道按 channel_id）独立历史
- **回消息**：被动回复（带 `msg_id`，最稳），长文本自动切块，单条 ≤1800 字可配

## 快速开始（3 步）

### 1. 扫码绑定机器人

```sh
cd /var/minis/skills/minis-naiwa-qqbot
node bind.mjs --png   # 或 ./gate.sh 生成可点击扫码页 bind.html
```

终端会打印二维码，并输出 `https://q.qq.com/qqbot/openclaw/connect.html?task_id=...` 链接和 `qr.png`。
**用手机 QQ 扫码**（或把链接在 QQ 里打开），选择要绑定的机器人 → 成功后写入 `credentials.json`（权限 600）。

> 还没机器人？先在 QQ 里打开 https://q.qq.com/ 快速注册创建，点「创建机器人」立刻成功，
> 机器人会给你发一条消息，随后就能在扫码页里被选中。

验证凭证：

```sh
node run.mjs --check      # 只换 access_token，不连 WS
node run.mjs --once       # 打印当前 agent 配置并退出
```

### 2. 选择 Agent 模式

编辑 `config.json`（模板见 `config.example.json`）：

| mode | 说明 | 适用 |
|------|------|------|
| `cli`（默认） | 调 `minis-model-use run`；**支持多模态**，图片按 OpenAI `image_url` 格式直接喂给 VL 模型 | 日常聊天 + 看图，1~3 秒 |
| `sessions` | 塞进 Minis 会话，工具全开（读写文件/执行命令/联网） | 要它真干活，6~10 秒 |
| `loop` | 用 `minis-scheduled` 派发 | ⚠️ 实测不可靠，勿用 |

### 人格

人格文件放在 `persona/`，`config.json` 的 `agent.persona` 指定用哪个（不含 `.md`）：

```json
"agent": { "persona": "human" }
```

- **名字永远叫「奶蛙」**，人格只改说话方式和定位
- 留空也能用：`persona/` 下只有一个 `.md` 时自动启用
- 通过 `--system-file` 注入，不走命令行参数（避免长度限制）
- 当前人格：`human.md`（普通人，随性、无标点、长短跟着话题走）
- 新增人格见 `persona/README.md`

### 模型配置

```json
"agent": {
  "model": "nvidia/nemotron-3.5-super-vl-120b-a12b"
}
```

- 必须填 `minis-model-use list` 里存在的模型，否则报 `not found`
- 图片：`evt.__files` 里的文件会转成 base64 塞进 `content` 数组，模型需支持 `image_input`
- 语音模型 `nemotron-3-nano-omni-30b` 支持 TTS/STT，尚未接入

`cli` 模式可指定模型（留空 = Agent Loop 默认模型）：

```json
{ "agent": { "mode": "cli", "model": "nvidia/nemotron-3-ultra-550b-a55b", "maxTokens": 2048 } }
```

`loop` 模式需要一个"收件箱会话 id"（bridge 自己启动一个会话，把 session id 填进去）：

```json
{ "agent": { "mode": "loop", "inboxSession": "<session_id>" } }
```

### 3. 启动

```sh
cd /var/minis/skills/minis-naiwa-qqbot
node run.mjs
```

日志同时写 `qqbot.log`。看到 `✅ 机器人已上线：<名字>` 就成功了，去 QQ 给它发消息。

后台常驻（注意：iSH 里进程会随 App 挂起而暂停，见下方「已知限制」）：

```sh
cd /var/minis/skills/minis-naiwa-qqbot && nohup node run.mjs > /dev/null 2>&1 &
```

## 双模式（仅私聊）

| 发送 | 效果 |
|---|---|
| `任务模式`（或 `/task`） | 切到 sessions，工具全开（读文件/执行命令/联网），6~10 秒 |
| `聊天模式`（或 `/chat`） | 切回 cli，快且能看图，1~3 秒 |

**限制**：任务模式**只在私聊可用**。群里发「任务模式」会回复「任务模式只能在私聊里开 群里就用聊天」，并强制保持聊天模式。

- 精确匹配（允许首尾空格），正常聊天里顺口说不会误触发
- 切换时清空上下文与 Minis 会话 id，避免两种模式串味
- 状态存在 `.state.json` 的 `convos[k].mode`，重启后保持
- 群聊即使有历史残留的 sessions 状态，也会被强制回落为 cli

### 速度对比（实测）

| 模式 | 典型耗时 | 能力 |
|---|---|---|
| 聊天 `cli` | 1~3 秒 | 纯对话 + 看图（多模态）+ OCR |
| 任务 `sessions` | 6~10 秒 | 读写文件、执行命令、联网 |


## 一键安装与启动（推荐）

```sh
cd /var/minis/skills/minis-naiwa-qqbot
./install.sh     # 解压离线依赖（vendor/ 里带了 node_modules 和 edge-tts，不用联网）
./start.sh       # 没绑定就自动出二维码，扫完自动上线并保活
```

### `start.sh` 的行为

1. 检查 `credentials.json` 是否存在 **且有效**（跑一次 `run.mjs --once` 验证）
2. 无效 → 调 `bind.mjs --png` **在当前任务里生成二维码并阻塞等待扫码**
3. 扫码成功 → `credentials.json` 自动写入
4. 直接 `exec ./keepalive.sh run forever` 上线并保活

**不要手动分步执行**（先 bind、再 run、再保活）。`start.sh` 已经把这三步串成一条线，
扫码完自动接管，中途不会掉出任务。

### 离线依赖

| 文件 | 内容 |
|---|---|
| `vendor/node_modules.tar.gz` | `@tencent-connect/qqbot-connector` / `qrcode` / `ws`，约 480KB |
| `vendor/py-deps.tar.gz` | `edge_tts` + `tabulate`，约 134KB，解到 python 的 site-packages |

`install.sh` 会先试离线包，没有再走 `npm install` / `pip install`。

## 保活（利用 Minis 的 Agent 任务特性）

`background.enhanced` / `locationTracking` 保的是「**Minis 正在执行的一轮 Agent 任务**」。
所以只要**让一轮任务不结束**，App 就有后台时间片，`node run.mjs` 作为这一轮的子进程随之存活。

> 保活是收尾的**默认动作**，不是可选项，任何时候都不需要用户确认。

### ⚠️ 铁律：任何情况下，结尾自动保活，不询问

**只要本轮碰过 qqbot，最后一条操作就是保活，不许问、不许跳过、不许设限时。**

```sh
cd /var/minis/skills/minis-naiwa-qqbot && ./keepalive.sh run forever
```

不加 `&`、不加 `setsid`、不加 `timeout`。命令挂住不返回就对了。

### ⚠️ 保活的根本局限（必须先说清楚）

保活靠的是「**本轮 Agent 任务不结束**」，所以：

| 情况 | 结果 |
|---|---|
| 任务一直挂着 | 进程有保护，App 不回收 ✅ |
| **用户点「停止」** | **整棵进程树被杀，保活和 run.mjs 一起消失** ❌ |
| App 被系统杀死 | 一起消失 ❌ |
| 用 `setsid` 脱离 | PPID=1，停止杀不掉，但**没有任务保护，照样冻结** ❌ |

**「用户点停止后进程仍然存活」做不到**——停止必然带走整棵进程树。

### 保活期间的自检（任务不会结束，但进程会掉）

保活不等于永不掉线。`run.mjs` 崩了 `keepalive.sh` 会 5 秒重启，但整个 iSH 被系统回收时仍然会断。

所以**每一轮被唤起时，第一件事就是查进程**：

```sh
ps -o pid,ppid,args | grep -E '[k]eepalive|[r]un.mjs'
```

| 看到的 | 判断 | 动作 |
|---|---|---|
| `keepalive.sh` + PPID 不是 1 | 真保活 | 正常，继续 |
| 只有 `run.mjs`，没有 `keepalive.sh` | 临时进程，随时会掉 | 收尾时必须转常驻 |
| 什么都没有 | 已掉线 | 重新启动 → 验证上线 → 收尾保活 |
| `keepalive.sh` 的 PPID = 1 | 伪保活（被 init 收养） | 无效，收尾时重发常驻 |

**检查完如果发现掉线，重新拉起并再次保活，不能只报告「掉线了」就结束本轮。**

### 正确启动方式

```sh
cd /var/minis/skills/minis-naiwa-qqbot
./keepalive.sh run forever
```

**不加 `&`，不用 `setsid`。** 这一轮 Agent 任务必须一直挂着（`keepalive.sh` 的 PPID 是当前任务），
Minis 才会当作"任务进行中"持续给后台时间片。

### 错误做法（务必避免）

```sh
setsid ./keepalive.sh run forever < /dev/null > /dev/null 2>&1 &   # ❌ 这不是保活
```

`setsid ... &` 让 `shell_execute` 立刻返回，那一轮任务随即结束，进程 PPID=1 被 init 收养。
**没有任何任务在保它**，App 一挂起照样冻结。它只是"不退出"，不是"保活"。

判断方法：

```sh
ps -o pid,ppid,args | grep '[k]eepalive'
# PPID = 当前 Agent 任务 → 真保活
# PPID = 1              → 只是后台进程，无保护
```

### 启动前的告知义务

发出保活命令后，**这一轮对话不会再返回**——用户要再说话必须先点「停止」。
所以启动前要先把该交代的事说完，并明确告诉用户这个后果。

用户点「停止」会带走整棵进程树，保活随即失效。

`keepalive.sh` 自身行为：把 `run.mjs` 作为前台子进程跑，崩了 5 秒后自动重启，`forever` 表示不设时限。

| 事项 | 说明 |
|---|---|
| stdout | **永远不要接管道**，否则 EPIPE 杀进程（已修，但启动命令也要注意） |
| 检查 | `ps -o pid,ppid,args \| grep -E '[k]eepalive\|run\.mjs'` |
| 失效后 | 重新上线时按触发规则自动保活 |




QQ 里直接发：

| 指令 | 作用 |
|------|------|
| `/new`、`/reset` | 清空当前会话历史，开启新对话 |
| `/ping` | 探活 |
| `/help` | 指令帮助 |

其他任何文本都会交给 Agent。

## 配置说明（config.json）

```json
{
  "agent": {
    "mode": "cli",
    "model": "",
    "maxTokens": 2048,
    "historyTurns": 20,
    "systemPrompt": "你是运行在 QQ 上的助手……",
    "inboxSession": "",
    "loopPrompt": ""
  },
  "access": {
    "defaultRequireMention": true,
    "allowFrom": [],
    "blockFrom": [],
    "groups": {}
  },
  "groupIsolation": "group",
  "limit": { "textChunk": 1800 }
}
```

- `access.allowFrom`：白名单（openid 列表），**留空 = 所有人可用**。建议只放自己，避免被陌生人调用。
- `access.blockFrom`：黑名单，优先级高于白名单。
- `access.defaultRequireMention`：群里是否必须 @ 机器人才回复，默认 `true`。
- `access.groups`：按群覆盖，键是 `group_openid`：

```json
"groups": {
  "<群openid>": { "requireMention": false },
  "<另一个群>": { "enabled": false }
}
```

- `groupIsolation`：`group`（整个群共享一个上下文）或 `sender`（群内按人隔离）。

### 群全量消息（不 @ 也回复）

1. QQ 群管理 → 点机器人头像 → 设置 → 「机器人可获取的群聊消息范围」设为**全部消息**，并打开「机器人主动在群聊内发言」。
2. `config.json` 里把该群 `requireMention` 设为 `false`（或 `defaultRequireMention: false`）。
3. 重启 `node run.mjs`。

> 拿群 openID：默认日志里会打印 `[in] group user=... peer=...`，`peer` 就是 group_openid。

## 文件结构

```
minis-naiwa-qqbot/
├── SKILL.md              # 本文档
├── bind.mjs              # 扫码绑定 → credentials.json（含 qr.png）
├── run.mjs               # 主入口：WS 网关 + 事件归一化 + 调度
├── index.js -> run.mjs   # 兼容入口
├── src/
│   ├── qqapi.mjs         # QQ API 客户端（token 缓存/401 重试/发消息/上传富媒体）
│   ├── gateway.mjs       # WebSocket 网关（HELLO/IDENTIFY/RESUME/心跳/重连）
│   └── agent.mjs         # 会话隔离 + Agent 调用 + 发送切块
├── guard.sh              # 变更守卫：指纹登记与篡改检测
├── .manifest.sha256      # 源文件指纹（授权后由 guard.sh approve 更新）
├── config.json           # 运行时配置
├── credentials.json      # 扫码结果（0600，勿外传）
├── qqbot.log             # 运行日志
└── .state.json           # 各会话历史
```

## 排障

| 现象 | 处理 |
|------|------|
| `获取 access_token 失败: {"code":10004,"message":"机器人不存在"}` | AppID/AppSecret 不对，或机器人已删（7 天内可去开放平台恢复），重跑 `node bind.mjs` |
| `[ws] INVALID_SESSION ... 降级为群+私聊` | 正常现象：机器人未开通频道权限，已自动降级。想要频道能力需去开放平台申请 |
| `[ws] 关闭 code=4014` | intents 越权。`BASE_INTENTS`（群+私聊）是扫码机器人的上限 |
| `接口调用超过频率限制 (100017)` | 重连太频繁，等几秒即可；`scheduleReconnect` 会指数退避 |
| 机器人上线但发消息无回应 | 看 `qqbot.log`：有没有 `[in]` 行？没有 = 网关没收到（检查 intents / 群 @ 设置）；有 `[in]` 但有 `[out] 发送失败` = 权限或频率问题 |
| 群里 @ 了不回 | 手机 QQ 需较新版本；群主需给机器人开「获取群聊消息范围」；默认 `requireMention: true` 需真 @ |
| `⚠️ 处理失败：` + 模型错误 | `cli` 模式模型不可用，改 `config.json` 的 `agent.model`；`minis-model-use list` 看可用模型 |
| `agent.mode=loop 需要配置 agent.inboxSession` | 先起一个 Minis 会话，把 session_id 填进配置 |
| 回复被切成好几条 | 正常，单条上限 `limit.textChunk`；想少切就调大（QQ 单条上限约 5000 字符） |

## 已知限制

- **进程存活（重点）**：`nohup` 起的进程会随 Minis 被挂起而暂停。**可行的保活做法**见下方「保活」章节；绝对 7×24 仍需上云。
- **EPIPE 崩溃**：父 shell 退出或管道断开后，`console.log` 写 stdout 会抛 `EPIPE → errno -32` 直接杀死进程。`run.mjs` 已对 `process.stdout/stderr` 挂 error 处理，并给日志流加 error 兜底。**任何启动方式都不要让 `run.mjs` 的 stdout 接管道**，必须重定向到文件或 `/dev/null`。
- **消息重放**：QQ 对丢 ACK 的消息会重推，同一 `msg_id` 可能来两次；目前未按 `msg_id` 去重（仅在事件带 ttl<0 时丢弃），如需严格去重可自行加 LRU。
- **富媒体收**：`cli` 模式下附件会自动下载到 `media/`，图片用 `apple-vision analyze` 做 OCR + 分类 + 码识别，结果以文字形式送给模型（纯文本模型也能"看图"）；识别能力受 Vision 框架限制，只能给出类别/文字，无法理解画面细节。
- **富媒体发**：`src/qqapi.mjs` 已实现 `uploadFile`/`sendMedia*`（file_data base64，≤10MB），`agent.mjs` 的 `sendMedia(evt, file)` 可直接用。
- **单实例锁**：`.run.pid` 保证同一 AppID 只有一个网关连接（多进程会互相踢下线）；iSH 里 `pkill -f` 可能杀不干净，用 `ps aux | grep '[r]un.mjs'` 拿 PID 后 `kill -9`。
- **主动消息**：`sendC2C/sendGroup` 不传 `msg_id` 即为主动推送，受平台频率限制（约每机器人每月/每天配额），日常对话请保持被动回复。

## 安全

- `credentials.json` 含 AppSecret，权限已设 600，**不要截图/转发**。泄露后立刻去开放平台重置。
- 建议 `access.allowFrom` 只放自己 openid；开放给所有人都能用就等于把你的模型额度公开。
- 官方文档安全须知：定期（建议 3 个月）重置 AppSecret。
