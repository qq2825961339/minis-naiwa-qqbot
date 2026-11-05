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
      attachments: (d.attachments || []).map((x) => ({ url: x.url, contentType: x.content_type })),
    };
  }

  if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') {
    return {
      ...base, scene: 'group', peerId: d.group_openid, userId: d.author?.member_openid,
      text: cleanText(d.content), timestamp: d.timestamp,
      // GROUP_AT_MESSAGE_CREATE 一定是 @；GROUP_MESSAGE_CREATE 是开启了"接收全部消息"后的非 @ 消息
      mentioned: t === 'GROUP_AT_MESSAGE_CREATE',
      attachments: (d.attachments || []).map((x) => ({ url: x.url, contentType: x.content_type })),
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

// ---------------- 凭证：环境变量 / 扫码，二选一 ----------------
const ENV_ID = 'QQBOT_APPID';
const ENV_SECRET = 'QQBOT_SECRET';
const DL_ID = 'minis://settings/environments?create_key=QQBOT_APPID&create_value=&create_note=QQ%20Bot%20AppID%20%E4%BB%8E%20https%3A%2F%2Fq.qq.com%2F%E8%8E%B7%E5%8F%96';
const DL_SECRET = 'minis://settings/environments?create_key=QQBOT_SECRET&create_value=&create_note=QQ%20Bot%20AppSecret%20%E4%BB%8E%20https%3A%2F%2Fq.qq.com%2F%E8%8E%B7%E5%8F%96';

function envCreds() {
  const id = process.env[ENV_ID];
  const secret = process.env[ENV_SECRET];
  return id && secret ? { appId: id.trim(), appSecret: secret.trim(), userOpenid: null } : null;
}

/** 从环境变量的「备注」读凭证（用户选择把凭证存放在 note 里，值字段无法写入） */
function noteCreds() {
  const readNote = (key) => {
    try {
      const out = execFileSync('minis-config', ['get', `envvars.${key}.note`],
        { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
      let v = JSON.parse(out)?.value ?? '';
      // value 可能带引号
      v = String(v).trim().replace(/^"|"$/g, '').replace(/\\\//g, '/');
      return v;
    } catch { return ''; }
  };
  const id = readNote(ENV_ID);
  const secret = readNote(ENV_SECRET);
  // AppID 一般 10 位左右，Secret 32 位；都齐全才算有效
  if (id.length >= 6 && secret.length >= 16) {
    return { appId: id, appSecret: secret, userOpenid: null, from: 'note' };
  }
  return null;
}
function fileCreds() {
  try {
    const c = loadJson('credentials.json', 'credentials.json');
    const b = c.bots?.[0] || c;
    return b?.appId && b?.appSecret ? b : null;
  } catch { return null; }
}

/** --login env|qr；不传则自动：环境变量优先，都存在时提示 */
function resolveCredentials() {
  const i = args.indexOf('--login');
  const want = i >= 0 ? String(args[i + 1] || '').toLowerCase() : '';
  const fromEnv = envCreds();
  const fromFile = fileCreds();

  if (want === 'env') {
    // 备注里的凭证优先：值字段可能被写坏（如 Secret 被截断），备注是我们主动同步的正确值
    const c = noteCreds() || envCreds();
    if (!c) {
      console.error(`\n❌ 指定 --login env，但环境变量 ${ENV_ID} / ${ENV_SECRET} 值或备注都读不到凭证。\n`);
      console.error(`   去这里填写（值无效时也可写进备注）：\n   ${DL_ID}\n   ${DL_SECRET}\n`);
      process.exit(4);
    }
    log(`[auth] 登录方式：AppID/AppSecret（${c.from === 'note' ? '环境变量备注' : '环境变量值'}）`);
    return c;
  }

  if (want === 'qr') {
    if (!fromFile) {
      console.error('\n❌ 指定 --login qr，但没有 credentials.json。请先运行：node bind.mjs --png\n');
      process.exit(5);
    }
    log('[auth] 登录方式：扫码（credentials.json）');
    return fromFile;
  }

  if (want && !['env', 'qr'].includes(want)) {
    console.error(`\n❌ --login 只接受 env 或 qr，收到：${want}\n   用法：node run.mjs --login env   或   node run.mjs --login qr\n`);
    process.exit(6);
  }

  // 自动模式：优先凭据文件（扫码），备注可作为补充
  const fromNote = noteCreds();
  if (fromFile) { log('[auth] 登录方式：扫码（credentials.json）'); return fromFile; }
  if (fromEnv) { log('[auth] 登录方式：AppID/AppSecret（环境变量值）'); return fromEnv; }
  if (fromNote) { log('[auth] 登录方式：AppID/AppSecret（环境变量备注）'); return fromNote; }

  console.error(`\n❌ 没有可用凭证。两种方式任选：\n`);
  console.error(`   1) 扫码：node bind.mjs --png`);
  console.error(`   2) 环境变量：在设置里填写 ${ENV_ID} 与 ${ENV_SECRET}（值无效时也可写进备注）`);
  console.error(`      ${DL_ID}`);
  console.error(`      ${DL_SECRET}\n`);
  process.exit(2);
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
