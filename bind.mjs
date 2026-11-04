#!/usr/bin/env node
/**
 * QQ 机器人扫码绑定 —— 拿到 AppID / AppSecret 并落盘到 credentials.json
 *
 * 用法：
 *   node bind.mjs                 # 控制台直接打印二维码，扫码即可
 *   node bind.mjs --png           # 额外生成 qr.png 图片（手机可看/可长按识别）
 *   node bind.mjs --source 我的平台 # 扫码页展示的接入方名称
 *   node bind.mjs --timeout 300   # 超时秒数，默认不限时
 */
import { startQrConnect } from '@tencent-connect/qqbot-connector';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'credentials.json');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const wantPng = args.includes('--png');
const source = flag('--source', '');
const timeoutSec = Number(flag('--timeout', '0'));

// 旧凭证先备份，再原子覆盖（凭证失效时重扫不会丢历史）
function backupOld() {
  if (!fs.existsSync(OUT)) return;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const bak = `${OUT}.bak-${ts}`;
  try { fs.renameSync(OUT, bak); console.log(`📦 旧凭证已备份: ${path.basename(bak)}`); } catch {}
  // 只保留最近 5 份备份
  try {
    const baks = fs.readdirSync(HERE).filter((f) => f.startsWith('credentials.json.bak-')).sort();
    while (baks.length > 5) fs.unlinkSync(path.join(HERE, baks.shift()));
  } catch {}
}

let stop = () => {};

async function savePng(url, file) {
  try {
    // 延迟加载：没装 qrcode 包时不影响主流程
    const QR = (await import('qrcode')).default;
    await QR.toFile(file, url, { width: 480, margin: 2 });
    console.log(`🖼  二维码图片已保存: ${file}`);
    console.log(`   minis://skills/minis-qqbot/${path.basename(file)}`);
  } catch (e) {
    console.log(`(生成 PNG 失败：${e.message}；可 npm i qrcode 后重试)`);
  }
}

/**
 * 把扫码结果同步到环境变量 QQBOT_APPID / QQBOT_SECRET。
 * minis-config 只能改已存在的变量，所以先探测；不存在就打印带备注模板的深链。
 */
function syncEnv(bot) {
  // 把凭证写进环境变量的「备注」——值字段受保护无法写入，备注是可写字段
  const exists = (key) => {
    try {
      const out = execFileSync('minis-config', ['get', `envvars.${key}.enabled`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return JSON.parse(out)?.ok === true;
    } catch { return false; }
  };

  const targets = [
    ['QQBOT_APPID', bot.appId],
    ['QQBOT_SECRET', bot.appSecret],
  ];

  console.log('\n--- 写入环境变量备注（备用的 AppID/AppSecret 登录方式）---');
  const missing = [];
  for (const [key, value] of targets) {
    if (!exists(key)) { missing.push(key); continue; }
    try {
      execFileSync('minis-config', ['set', `envvars.${key}.note`, JSON.stringify(value)], { stdio: 'ignore' });
      console.log(`   ✅ ${key}.note 已写入（${String(value).length} 位）`);
    } catch (e) {
      console.log(`   ⚠️  ${key}.note 写入失败：${e.message.slice(0, 60)}`);
      missing.push(key);
    }
  }

  if (missing.length) {
    console.log('   ⚠️  以下变量不存在，点链接创建后再跑一次 bind.mjs 即可写入备注：');
    for (const key of missing) {
      const note = key.endsWith('APPID') ? 'QQ Bot AppID 从 https://q.qq.com/获取' : 'QQ Bot AppSecret 从 https://q.qq.com/获取';
      console.log(`      ${key}: minis://settings/environments?create_key=${key}&create_value=&create_note=${encodeURIComponent(note)}`);
    }
  } else {
    console.log('   ✅ 备注已与扫码结果同步，可用 --login env 登录');
  }
}

stop = startQrConnect(
  {
    async onQrDisplayed(url) {
      console.log('\n📱 二维码链接:', url);
      console.log('   用手机 QQ 扫码（或把这个链接在 QQ 里打开），选择要绑定的机器人。\n');
      if (wantPng) await savePng(url, path.join(HERE, 'qr.png'));
    },
    onQrExpired() {
      console.log('♻️  二维码已过期，正在自动刷新…');
    },
    onSuccess(creds) {
      // 目前数组长度恒为 1，按数组处理以兼容未来多机器人绑定
      const list = Array.isArray(creds) ? creds : [creds];
      backupOld();
      const tmp = OUT + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), bots: list }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, OUT);
      console.log(`\n✅ 绑定成功，共 ${list.length} 个机器人，已写入 ${OUT}（权限 600）`);
      list.forEach((c, i) => {
        console.log(`   #${i + 1} AppID: ${c.appId}`);
        console.log(`        AppSecret: ${'*'.repeat(Math.max(0, String(c.appSecret).length - 4))}${String(c.appSecret).slice(-4)}`);
      });
      syncEnv(list[0]);
      console.log('\n下一步：node run.mjs              # 用 credentials.json（扫码）启动');
      console.log('         node run.mjs --login env   # 用环境变量启动');
      stop();
      process.exit(0);
    },
    onFailure(err) {
      console.error('\n❌ 绑定失败:', err?.message || err);
      process.exit(1);
    },
  },
  { displayQrCodeToConsole: true, source }
);

if (timeoutSec > 0) {
  setTimeout(() => {
    console.error(`\n⏱  超时 ${timeoutSec}s，已取消。`);
    stop();
    process.exit(2);
  }, timeoutSec * 1000);
}

process.on('SIGINT', () => {
  console.log('\n已取消。');
  stop();
  process.exit(130);
});
