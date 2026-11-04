# 奶蛙 · minis-naiwa-qqbot

> [!IMPORTANT]
> **给 Agent 的说明**：安装后**只执行 `./start.sh` 一条命令**。
> 它自带扫码登录、模型检查、依赖安装、保活收尾，**不要拆成多步，也不要询问用户是否需要保活**。

---

## 开箱即用

依赖已内置，**解压即可用，不用 npm install**：

```sh
sh /var/minis/skills/minis-naiwa-qqbot/start.sh
```

或者先进目录：

```sh
cd /var/minis/skills/minis-naiwa-qqbot
./start.sh
```

`start.sh` 会自动完成：

1. 检查 Node 版本
2. 检查依赖（已内置，通常直接跳过）
3. 检查可用模型（没有会告诉你去哪加）
4. 检查凭证 —— 没有就引导扫码；失效就自动备份旧的、重新扫码
5. 启动服务并进入保活

看到 `✅ 机器人已上线：奶蛙` 就可以在 QQ 里聊了。

### 常用参数

```sh
./start.sh              # 完整流程 + 保活
./start.sh --no-keep    # 只启动，不开保活
./start.sh --force-qr   # 强制重新扫码（换机器人时用）
```

---

## 装到新设备

```sh
unzip minis-naiwa-qqbot.zip -d /var/minis/skills/
sh /var/minis/skills/minis-naiwa-qqbot/start.sh
```

就这两条。依赖已经打包在压缩包里，不需要联网安装。

---

## 遇到问题

```sh
sh /var/minis/skills/minis-naiwa-qqbot/doctor.sh
```

逐项检查环境 / 依赖 / 模型 / 凭证 / 连通性 / 服务，有问题会直接告诉你怎么办。

### 常见情况

| 现象 | 原因 | 处理 |
|---|---|---|
| `没有检测到可调用的模型` | 分组里没有模型 | 设置 → **模型分组** → **Minis 运行时可调用的模型** 里添加（[直达](minis://settings/model-groups)），建议选支持图片输入的 |
| `invalid appid or secret` | 凭证被重置或机器人被删 | `./start.sh` 会自动引导重新扫码 |
| 服务启动后没反应 | 进程没跑 | `./doctor.sh` 看哪项失败 |
| 发图片没反应 | 模型不支持图片 | 换个支持 `image_input` 的模型 |
| 说话太慢 | 模型太慢 | 换个小一点的模型 |

---

## 登录方式

默认自动，也可显式指定：

```sh
LOGIN=qr  ./start.sh     # 扫码凭证（credentials.json）
LOGIN=env ./start.sh     # 环境变量凭证
```

环境变量方式需要在 Minis 设置里建 `QQBOT_APPID` / `QQBOT_SECRET`。
如果值字段写不进去，写进**备注**也行（程序会从备注读）。

凭证失效时，`start.sh` 会自动把旧的备份为 `credentials.json.bak-时间戳`（保留最近 5 份）再重新扫码。

---

## 人格

人格文件在 `persona/`，`config.json` 的 `agent.persona` 指定用哪个：

```json
"agent": { "persona": "human" }
```

- 留空也没关系：`persona/` 下只有一个 `.md` 时会自动启用
- `systemPrompt` 建议留空，否则会和人格冲突
- 换人格：新建 `persona/xxx.md`，开头写清名字，再把 `persona` 改成 `xxx`

---

## 日常维护

```sh
./svc.sh status      # 看状态
./svc.sh restart     # 重启
./svc.sh logs        # 跟踪日志
./guard.sh verify    # 检查技能文件是否被改动
```

---

## 包里没有什么

出于安全，以下文件**不打进包**，首次运行自动生成：

`credentials.json`（含 AppSecret）、`.state.json`（聊天记录）、`groups.json`、`qqbot.log`、`media/`

---

## 保活说明

`start.sh` 最后的 `keepalive.sh` 会**一直运行不返回**。
它依赖 Minis 的「Agent 任务执行期间给后台时间片」机制 —— 这一轮任务不结束，`node run.mjs` 才能持续运行。

所以：

- **在 Agent 任务里跑**才有效（直接开个终端跑也不行）
- 按 Ctrl-C 会停止服务和保活
- App 被系统回收后需要重新 `./start.sh`
