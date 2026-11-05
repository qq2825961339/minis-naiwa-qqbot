/**
 * 奶蛙表情引擎 —— 模型自主 + 代码兜底
 *
 * 两条触发路径：
 *   1. 模型主动：回复里写 [表情:XX]（XX ≤ 4 字）
 *   2. 代码兜底：模型没写标签时，按情绪词自动补一张（autoSticker）
 *
 * 频率控制：minGapReplies 条回复内最多一张；最近 40 张去重；缓存 24h。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { searchEmoji } from './fabiaoqing.mjs';   // 发表情站，图源比搜狗准得多

const DEFAULT = {
  enabled: true,
  minGapReplies: 0,           // 0 = 每条都能配图          // 至少隔几条回复才再发
  pickFrom: 5,               // 前几张里随机挑
  maxSizeKB: 400,
  maxWidth: 800,
  maxHeight: 800,
  cacheTtlMs: 24 * 3600 * 1000,
  groupOnlyWhenMentioned: false,
  autoFallback: true,        // 模型没给标签时，代码兜底
};

// ---------------- 兜底词表 ----------------

const POSITIVE = [
  // 笑 / 乐（奶蛙自己在笑）
  ['笑死', '笑哭'], ['笑不活', '笑哭'], ['好笑', '笑哭'], ['哈哈', '笑哭'], ['乐了', '笑哭'],
  ['绷不住', '笑哭'], ['乐死', '笑哭'], ['笑趴', '笑哭'], ['绝了', '笑哭'], ['这都行', '笑哭'],
  ['笑啥', '笑哭'], ['笑什么', '笑哭'], ['逗', '笑哭'],
  // 无语 / 离谱（奶蛙在吐槽）
  ['离谱', '离谱'], ['服了', '无语'], ['无语', '无语'], ['抽象', '离谱'], ['难绷', '无语'],
  ['好家伙', '无语'], ['不是吧', '无语'], ['真的会谢', '无语'], ['裂开', '无语'], ['醉了', '无语'],
  ['别扯', '无语'], ['少来', '无语'], ['随你', '无语'],
  // 夸 / 牛
  ['牛逼', '牛'], ['牛啊', '牛'], ['太强', '牛'], ['厉害', '牛'], ['可以啊', '牛'],
  ['真行', '牛'], ['牛的', '牛'], ['牛批', '牛'], ['稳', '牛'],
  // 震惊
  ['卧槽', '震惊'], ['我靠', '震惊'], ['真的假的', '震惊'], ['炸裂', '震惊'],
  ['没想到', '震惊'], ['居然', '震惊'], ['竟然', '震惊'], ['不至于', '震惊'],
  // 累 / 摆烂
  ['摆烂', '摆烂'], ['躺平', '摆烂'], ['破防', '破防'], ['崩溃', '破防'],
  ['社畜', '累了'], ['打工', '累了'], ['上班', '累了'], ['加班', '累了'],
  // 安慰（奶蛙在安抚人）
  ['太难了', '太难了'], ['挺惨', '太难了'], ['心疼', '心疼'], ['好惨', '太难了'],
  ['别难过', '抱抱'], ['别想太多', '抱抱'], ['抱抱', '抱抱'], ['摸摸头', '摸摸'],
  ['会好的', '抱抱'], ['撑着', '抱抱'], ['不容易', '心疼'],
  // 尴尬
  ['尴尬', '尴尬'], ['社死', '尴尬'], ['丢人', '尴尬'],
  // 答应 / 日常
  ['行吧', '好的'], ['好吧', '好的'], ['可以', '好的'], ['收到', '好的'], ['好啊', '好的'],
  ['拜拜', '告辞'], ['走了', '告辞'], ['睡了', '晚安'], ['晚安', '晚安'], ['好梦', '晚安'],
  ['早', '早安'], ['早安', '早安'], ['饿了', '馋'], ['好饿', '馋'],
  ['困了', '困'], ['想睡', '困'], ['啥', '问号'], ['你说啥', '问号'],
];
/**
 * 代码兜底判断——模型没写 [表情:] 时调用
 * @returns {{query:string}|null}
 */
export function autoSticker(userText, replyText) {
  // 只看奶蛙自己说的话：图配的是它的情绪，不是用户的
  const all = String(replyText || '');
  for (const [word, query] of POSITIVE) {
    if (all.includes(word)) return { query };
  }
  return null;
}

// ---------------- 引擎 ----------------

export class StickerEngine {
  constructor({ here, config = {}, log = console.log }) {
    this.cfg = { ...DEFAULT, ...(config.access?.stickers || {}) };
    this.log = log;
    this.dir = path.join(here, 'persona', 'sticker-cache');
    this.seen = [];
    this.replyCount = 999;      // 起步允许立刻发
  }

  /** 抽 [表情:XX] 标签；XX 最多 4 字 */
  static parse(reply) {
    const raw = String(reply || '');
    const re = /\[表情[:：]\s*([^\]|]+?)\s*(?:\|[^\]]*)?\]/g;
    const m = re.exec(raw);
    if (!m) return { text: raw, want: false, query: '' };
    const q = [...m[1].replace(/[，。！？,.!?\s]/g, '')].slice(0, 4).join('');
    // 去掉所有表情标签，再清掉标签旁边残留的分条符，避免发出「给你|||」
    let text = raw.replace(re, '')
      .replace(/(\|{2,}\s*)+$/g, '')      // 结尾残留的 |||
      .replace(/^\s*(\|{2,}\s*)+/g, '')    // 开头残留的 |||
      .replace(/\s*\|{2,}\s*/g, '|||')      // 中间多个分隔符压成一个
      .trim();
    // 只剩分隔符就当空
    if (/^(\|{2,}\s*)+$/.test(text)) text = '';
    return { text, want: true, query: q };
  }

  /** 频率 + 场景检查；不通过时计一次回复 */
  canSend(evt) {
    if (!this.cfg.enabled) return false;
    if (this.cfg.groupOnlyWhenMentioned && evt?.scene === 'group' && !evt?.mentioned) return false;
    if (this.replyCount < this.cfg.minGapReplies) {
      this.replyCount++;
      return false;
    }
    return true;
  }

  /** 搜一张图，只返回直链（不下载、不落盘） */
  async pick(query) {
    const list = await searchEmoji(query, { limit: 12 });
    if (!list.length) { this.log(`[sticker] 搜不到「${query}」`); return null; }

    const pool = list
      .filter((e) => (!e.width || e.width <= this.cfg.maxWidth) && (!e.height || e.height <= this.cfg.maxHeight))
      .slice(0, Math.max(1, this.cfg.pickFrom))
      .filter((e) => !this.seen.includes(e.thumb))
      .sort(() => Math.random() - 0.5);

    const e = pool[0] || list[0];
    if (!e) return null;
    const out = { url: e.thumb, query, title: e.title };
    this._noteUse(out);
    this.log(`[sticker] 「${query}」→ ${e.width}x${e.height} ${e.thumb.slice(-14)}`);
    return out;
  }





  _noteUse(st) {
    if (st?.url) this.seen.push(st.url);
    if (this.seen.length > 40) this.seen.shift();
    this.replyCount = 0;
  }

  /**
   * 一站式：给回复 + 用户原话，返回 { text, sticker }
   * sticker 为 null 表示这轮不发图
   */
  async resolve(userText, replyText, evt) {
    const p = StickerEngine.parse(replyText);
    let query = p.query;
    let byModel = p.want;

    if (!query && this.cfg.autoFallback) {
      const auto = autoSticker(userText, p.text);
      if (auto) { query = auto.query; byModel = false; }
    }
    if (!query) {
      this.replyCount++;
      return { text: p.text, sticker: null };
    }
    if (!this.canSend(evt)) return { text: p.text, sticker: null };

    const st = await this.pick(query);
    if (!st) return { text: p.text, sticker: null };
    this.replyCount = 0;   // 发图成功，重新计数
    if (st.url) { this.seen.push(st.url); if (this.seen.length > 40) this.seen.shift(); }
    this.log(`[sticker] 来源=${byModel ? '模型' : '兜底'}`);
    return { text: p.text, sticker: st };
  }
}
