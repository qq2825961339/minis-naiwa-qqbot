# 人格包

每个 `.md` 是一个可选人格，`config.json` 的 `agent.persona` 填文件名（不含扩展名）即可切换。

| 文件 | 说明 |
|---|---|
| `human.md` | 当前人格：奶蛙是个普通人，随性、无标点、一句话 |

## 规则

- **名字永远叫「奶蛙」**，人格只影响说话方式和定位，不改变名字
- 人格文件通过 `minis-model-use --system-file` 注入，不走 `--system`（避免命令行长度限制）
- `config.json` 的 `agent.systemPrompt` 保持为空，避免与 persona 冲突

## 新增人格

1. 在 `persona/` 下新建 `<名字>.md`
2. 开头写明「你是奶蛙」
3. 改 `config.json` → `agent.persona: "<名字>"`
4. 重启服务
