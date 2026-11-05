#!/usr/bin/env node
/**
 * 确保指令面板与自定义菜单已配置（幂等，可重复执行）
 *
 *   node scripts/ensure-panels.mjs          检查并补齐（缺什么建什么）
 *   node scripts/ensure-panels.mjs --force  全部删除后重建
 *   node scripts/ensure-panels.mjs --check  只检查不修改
 *
 * 为什么需要：面板和菜单绑定在具体 AppID 上，换账号 / 换设备扫码后，
 * 旧的面板不会跟过来，必须重新建一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QQApi } from '../src/qqapi.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const CHECK_ONLY = args.includes('--check');

// ---- 配置：面板/菜单内容集中在这里 ----
const PANEL_ITEMS = [
  { type: 'command', name: '/点歌', desc: '想听啥说啥' },
  { type: 'command', name: '/找视频', desc: '随便看个视频' },
  { type: 'command', name: '/换视频', desc: '再来一个' },
];

const MENU_ITEMS = [
  { type: 'send_message', name: '点歌', send_message: '/点歌' },
  { type: 'send_message', name: '找视频', send_message: '/找视频' },
  { type: 'send_message', name: '换视频', send_message: '/换视频' },
];

function loadCreds() {
  const p = path.join(HERE, 'credentials.json');
  if (!fs.existsSync(p)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    const b = c.bots?.[0] || c;
    return b?.appId && b?.appSecret ? b : null;
  } catch {
    return null;
  }
}

/** 两套面板配置是否一致（服务端会去掉 name 里的 /，比较时统一去掉） */
const norm = (x = '') => String(x).replace(/^\/+/, '');
function sameItems(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((x, i) =>
    norm(x.name) === norm(b[i].name) && (x.desc || '') === (b[i].desc || '') && x.type === b[i].type);
}

async function listPanels(api, scope) {
  try {
    const r = await api.request('GET', `/v2/panels?scope=${scope}`);
    return r.records || [];
  } catch {
    return [];
  }
}

async function createPanel(api, scope) {
  const r = await api.request('POST', '/v2/panels', {
    body: { scope, target_type: 'all', panel: { items: PANEL_ITEMS, remark: `naiwa-${scope}` } },
  });
  return r?.panel_id;
}

async function deletePanel(api, id) {
  await api.request('DELETE', `/v2/panels/${id}`);
}

async function ensureMenu(api) {
  let cur = null;
  try {
    cur = await api.request('GET', '/v2/menu');
  } catch {}
  const items = cur?.menu?.items || [];
  const ok = items.length === MENU_ITEMS.length
    && items.every((x, i) => x.name === MENU_ITEMS[i].name && x.send_message === MENU_ITEMS[i].send_message);
  if (ok && !FORCE) return { changed: false, version: cur?.version };
  if (CHECK_ONLY) return { changed: true, need: 'menu' };
  const r = await api.request('PUT', '/v2/menu', { body: { menu: { items: MENU_ITEMS } } });
  return { changed: true, version: r?.version };
}

async function main() {
  const cred = loadCreds();
  if (!cred) {
    console.log('❌ 没有 credentials.json，先扫码绑定（./start.sh）');
    process.exit(2);
  }
  const api = new QQApi({ appId: cred.appId, appSecret: cred.appSecret, log: () => {} });
  console.log(`appId: ${cred.appId}`);
  if (CHECK_ONLY) console.log('（--check 只检查，不修改）\n');

  let changed = 0;

  // ---- 指令面板 ----
  for (const scope of ['c2c', 'group']) {
    const records = await listPanels(api, scope);
    const cur = records[0];

    if (cur && !FORCE) {
      const same = sameItems(cur.panel?.items || [], PANEL_ITEMS);
      if (same) {
        console.log(`✅ ${scope} 面板已存在且一致（${cur.panel_id}）`);
        continue;
      }
      console.log(`⚙️  ${scope} 面板内容不一致，更新中…`);
      if (CHECK_ONLY) { changed++; continue; }
      try {
        await api.request('PUT', `/v2/panels/${cur.panel_id}`, { body: { panel: { items: PANEL_ITEMS, remark: `naiwa-${scope}` } } });
        console.log(`   ✅ 已更新 ${cur.panel_id}`);
        changed++;
      } catch (e) {
        console.log(`   ❌ 更新失败：${e.message.slice(0, 80)}`);
      }
      continue;
    }

    if (CHECK_ONLY) {
      console.log(`⚠️  ${scope} 面板缺失`);
      changed++;
      continue;
    }
    if (FORCE) {
      for (const r of records) { await deletePanel(api, r.panel_id).catch(() => {}); }
    }
    try {
      const id = await createPanel(api, scope);
      console.log(`✅ ${scope} 面板已创建 ${id}`);
      changed++;
    } catch (e) {
      console.log(`❌ ${scope} 创建失败：${e.message.slice(0, 120)}`);
    }
  }

  // ---- 自定义菜单（仅单聊）----
  const m = await ensureMenu(api);
  if (m.changed) {
    console.log(`✅ 自定义菜单已更新（version ${m.version ?? '?'}）`);
    changed++;
  } else {
    console.log('✅ 自定义菜单已存在且一致');
  }

  console.log(changed ? `\n完成，改动 ${changed} 处` : '\n全部就绪，无需改动');
}

main().catch((e) => {
  console.log(`❌ 执行失败：${e.message}`);
  process.exit(1);
});
