#!/usr/bin/env node
/**
 * minis-qqbot —— QQ 机器人 ↔ Minis Agent Loop 桥接
 *
 *   node run.mjs            启动（读取 config.json + credentials.json）
 *   node run.mjs --check    只做连通性检查（拿 token、验凭证），不连 WS
 *   node run.mjs --once     /status 自检后退出
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QQApi } from './src/qqapi.mjs';
import { QQGateway } from './src/gateway.mjs';
import { AgentBridge } from './src/agent.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LOG_FILE = path.join(HERE, 'qqbot.log');

// 日志：stdout 给前台看，文件用流写（比每行 appendFileSync 省 IO，也不怕被重定向重复）
// 日志轮转：超过 5MB 滚动为 qqbot.log.1，只留一份
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  }
} catch {}
const LOG_STREAM = fs.createWriteStream(LOG_FILE, { flags: 'a' });
LOG_STREAM.on('error', () => {});   // 日志盘写失败也不能弄死网关

// stdout/stderr 断管（父 shell 退出、管道关闭）时不要让 EPIPE 杀死进程
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
const _stdoutOk = () => { try { return process.stdout.writable; } catch { return false; } };

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  if (_stdoutOk()) { try { console.log(line); } catch {} }
  try { LOG_STREAM.write(line + '\n'); } catch {}
}

function loadJson(f, name) {
  const p = path.join(HERE, f);
  if (!fs.existsSync(p)) throw new Error(`缺少 ${name}：${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------- 事件归一化 ----------------
function normalize(t, d) {
  const base = { raw: t, msgId: d?.id, ttl: 0 };

  if (t === 'C2C_MESSAGE_CREATE') {
    return {
      ...base, scene: 'c2c', peerId: d.author?.user_openid, userId: d.author?.user_openid,
      text: cleanText(d.content), timestamp: d.timestamp, mentioned: true,
      // QQ 服务端自带的语音转文字（语音消息时 content 是空的，文字在这里）
      asrText: (d.attachments || []).map((x) => x.asr_refer_text).filter(Boolean).join(' '),
      // 引用回复用：从 message_scene.ext 里取 msg_idx=REFIDX_xxx
      refIdx: (d.message_scene?.ext || []).map((e) => String(e)).join(' ').match(/msg_idx=(REFIDX_[A-Za-z0-9+/=_-]+)/)?.[1] || '',
      attachments: (d.attachments || []).map((x) => ({
        url: x.url, contentType: x.content_type, filename: x.filename,
        asrText: x.asr_refer_text || '',      // QQ 自带语音转文字
        wavUrl: x.voice_wav_url || '',        // QQ 直接给的 wav，无需解 silk
      })),
      raw_data: d,
    };
  }

  if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') {
    return {
      ...base, scene: 'group', peerId: d.group_openid, userId: d.author?.member_openid,
      text: cleanText(d.content), timestamp: d.timestamp,
      // GROUP_AT_MESSAGE_CREATE 一定是 @；GROUP_MESSAGE_CREATE 是开启了"接收全部消息"后的非 @ 消息
      mentioned: t === 'GROUP_AT_MESSAGE_CREATE',
      asrText: (d.attachments || []).map((x) => x.asr_refer_text).filter(Boolean).join(' '),
      attachments: (d.attachments || []).map((x) => ({
        url: x.url, contentType: x.content_type, filename: x.filename,
        asrText: x.asr_refer_text || '',      // QQ 自带语音转文字
        wavUrl: x.voice_wav_url || '',        // QQ 直接给的 wav，无需解 silk
      })),
      raw_data: d,
    };
  }

  if (t === 'AT_MESSAGE_CREATE' || t === 'MESSAGE_CREATE' || t === 'DIRECT_MESSAGE_CREATE') {
    return {
      ...base, scene: t === 'DIRECT_MESSAGE_CREATE' ? 'dm' : 'guild', peerId: d.channel_id,
      userId: d.author?.id, userName: d.author?.username, text: cleanText(d.content),
      timestamp: d.timestamp, mentioned: t === 'AT_MESSAGE_CREATE', guildId: d.guild_id,
      attachments: (d.attachments || []).map((x) => ({ url: x.url, contentType: x.content_type })),
    };
  }
  return null;
}

/** 去掉 <@!123> 这类 @ 标记与多余空白 */
function cleanText(s = '') {
  return String(s)
    .replace(/<@!?\d+>/g, '')
    .replace(/<faceType=\d+[^>]*>/g, '')
    .replace(/<qqmedia>|<\/qqmedia>/g, '')
    .trim();
}

// ---------------- 主流程 ----------------
const cfgPath = path.join(HERE, 'config.json');
let config = { agent: { mode: 'cli' }, access: { defaultRequireMention: true }, limit: { textChunk: 1800 } };
if (fs.existsSync(cfgPath)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
  config.agent = { ...{ mode: 'cli' }, ...(config.agent || {}) };
  config.access = { ...{ defaultRequireMention: true }, ...(config.access || {}) };
}

// ---------------- 凭证：只支持扫码（credentials.json） ----------------
const DL = 'minis://skills/minis-naiwa-qqbot/start.sh';

function fileCreds() {
  try {
    const c = loadJson('credentials.json', 'credentials.json');
    const b = c.bots?.[0] || c;
    return b?.appId && b?.appSecret ? b : null;
  } catch { return null; }
}

/** 只认扫码凭证；没有就让上层去跑 bind.mjs */
function resolveCredentials() {
  const c = fileCreds();
  if (!c) {
    console.error('\n❌ 没有可用凭证（credentials.json 不存在或损坏）。\n');
    console.error('   运行 ./start.sh 会自动生成二维码，扫码后自动上线。\n');
    process.exit(2);
  }
  log('[auth] 登录方式：扫码（credentials.json）');
  return c;
}

const bot = resolveCredentials();

const api = new QQApi({ appId: bot.appId, appSecret: bot.appSecret, log });

// --check / --once 是诊断用途，不受单实例锁限制
if (args.includes('--check')) {
  const t = await api.getToken();
  log(`✅ 凭证有效，access_token 已获取（${t.slice(0, 6)}…，共 ${t.length} 字符）`);
  process.exit(0);
}
if (args.includes('--once')) {
  await api.getToken();
  log('✅ 自检通过：凭证可用，配置已加载');
  log(`   agent.mode = ${config.agent.mode}${config.agent.model ? `, model = ${config.agent.model}` : '（默认模型）'}`);
  process.exit(0);
}

// ---- 单实例锁：QQ 同一 AppID 允许多网关连接会互相踢下线，必须保证只有一个进程 ----
const LOCK = path.join(HERE, '.run.pid');
function acquireLock() {
  if (fs.existsSync(LOCK)) {
    const old = Number(fs.readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    try { if (old && old !== process.pid) { process.kill(old, 0); alive = true; } } catch { alive = false; }
    if (alive) {
      log(`⛔ 已有实例在运行（pid ${old}），退出。如需重启：kill ${old} 后重试`);
      process.exit(3);
    }
  }
  fs.writeFileSync(LOCK, String(process.pid));
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK) && Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK);
  } catch {}
}
acquireLock();
process.on('exit', releaseLock);

const bridge = new AgentBridge({ api, config, here: HERE, log });
bridge.startAutoSave(5000);
const gw = new QQGateway(api, { log });

gw.on('dispatch', (t, d) => {
  if (t === 'C2C_MSG_RECEIVE') {
    // 仅"允许主动推送"时才有，一般是提示事件
    log(`[evt] C2C_MSG_RECEIVE openid=${d?.openid}`);
    return;
  }
  if (t === 'INTERACTION_CREATE') {
    log(`[evt] INTERACTION_CREATE ${d?.data?.resolved?.button_data || ''}`);
    return;
  }
  const evt = normalize(t, d);
  if (!evt) {
    log(`[evt] ${t}（未处理）`);
    return;
  }
  bridge.handle(evt);
});

gw.on('ready', (d) => {
  log(`✅ 机器人已上线：${d?.user?.username || d?.user?.id || bot.appId}`);
});

log(`🚀 minis-naiwa-qqbot 启动  appId=${bot.appId}  模式=${config.agent?.defaultMode || config.agent?.mode || 'cli'}`);

// 启动时先探一次模型，缺模型立刻提示怎么加，不要等到用户发消息才报错
bridge.selectModel().then((sel) => {
  log(`[model] 就绪：${sel.name}${sel.vision ? '（可看图）' : '（纯文本）'}`);
}).catch((e) => {
  log('');
  log('════════════════════════════════════════');
  log('❌ 没有可调用的模型，奶蛙现在没法回复消息');
  log('');
  log('   解决办法：');
  log('   1. 打开：设置 → 模型分组 → Minis 运行时可调用的模型');
  log('      minis://settings/model-groups');
  log('   2. 加一个模型，建议选支持图片输入的（能看到你发的图）');
  log('   3. 确认它出现在列表里：minis-model-use list --all');
  log('   4. 重启服务：./start.sh');
  log('════════════════════════════════════════');
  log('');
});

gw.connect().catch((e) => {
  log(`❌ 启动失败: ${e.stack || e.message}`);
  process.exit(1);
});

const shutdown = () => {
  releaseLock();
  log('👋 正在退出…');
  bridge.saveState();
  bridge.stopAutoSave();
  gw.close();
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log(`[unhandledRejection] ${e?.stack || e}`));
