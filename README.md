# 奶蛙 · minis-naiwa-qqbot

> [!IMPORTANT]
> **给 Agent 的说明**：安装后**只执行 `./start.sh` 一条命令**。

> 一个跑在 iPhone 上的 QQ 机器人，接 Minis 的模型。
> 能聊天、能看图、会分条追问，人格可以换。

## 一条命令启动

**解压后直接运行，不用先装依赖**（依赖已内置）：

```sh
sh /var/minis/skills/minis-naiwa-qqbot/start.sh
```

也可以先进目录再跑：

```sh
cd /var/minis/skills/minis-naiwa-qqbot && ./start.sh
```


看到 `✅ 机器人已上线：奶蛙` 就能在 QQ 里聊了。

## 特性

- **扫码绑定** — 官方 SDK 扫码即得 AppID/AppSecret，也支持环境变量
- **自动选模型** — 优先挑能看图的；没有就退回纯文本
- **看图** — 图片按多模态格式直传，GIF 自动转静态帧
- **多轮记忆** — 私聊/群聊各自独立上下文，重启不丢
- **像真人** — 无标点、用空格断句、长度跟着话题走、不硬凑条数
- **双模式** — 私聊可切「任务模式」调用工具（读文件/执行命令），群里只走聊天
- **人格可换** — `persona/` 目录放 Markdown，换个文件就是换个人
- **自动恢复** — 凭证失效自动备份重扫；进程崩溃 5 秒重启
- **自检工具** — `./doctor.sh` 逐项体检

## 前置条件

- iPhone + Minis App（iSH 环境）
- Node >= 18（Minis 自带）
- Minis 里至少配好一个模型

## 文档

- [INSTALL.md](INSTALL.md) — 安装、排障、人格配置

## 目录

```
start.sh          一键启动
doctor.sh         体检
bind.mjs          扫码绑定
run.mjs           主入口（WS 网关 + 调度）
src/
  agent.mjs       会话隔离、模型调用、分条发送
  gateway.mjs     QQ WebSocket 网关
  qqapi.mjs       QQ API 客户端
persona/
  human.md        人格（可换）
svc.sh            进程管理
guard.sh          变更守卫
```

## 安全

- `credentials.json` 含 AppSecret，已在 `.gitignore` 中，**请勿提交**
- 建议在 `config.json` 的 `access.allowFrom` 填自己的 openid，避免他人调用消耗额度
- 定期（3 个月）去 QQ 开放平台重置 AppSecret

## License

MIT
