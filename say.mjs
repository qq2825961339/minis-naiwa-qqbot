// 主动推送测试消息给绑定者（不需要 msg_id）
import fs from 'node:fs';
import { QQApi } from '/var/minis/skills/minis-qqbot/src/qqapi.mjs';

const c = JSON.parse(fs.readFileSync('/var/minis/skills/minis-qqbot/credentials.json', 'utf8'));
const bot = c.bots[0];
const api = new QQApi({ appId: bot.appId, appSecret: bot.appSecret, log: (m) => console.log(m) });

const text = process.argv[2] || '👋 我是已接入 Minis 的 QQ 助手，链路已打通。直接发消息试试，/help 看指令。';
try {
  const r = await api.sendC2C(bot.userOpenid, text);
  console.log('✅ 主动消息已发送:', JSON.stringify(r));
} catch (e) {
  console.log('❌ 发送失败:', e.message);
}
