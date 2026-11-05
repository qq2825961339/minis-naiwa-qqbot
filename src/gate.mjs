/**
 * 说话时机判定（gate）—— 决定一条消息「该不该回」
 *
 * 设计原则（参考 qq-dsh-bridge / jiangyouyu 的做法）：
 *   1. 明确冲着奶蛙来的（@、引用奶蛙、点名）→ 必须回
 *   2. 私聊 → 默认回（除非明显是刷屏）
 *   3. 群里没点名的闲聊 → 按温度判断：冷场随便接，吵起来就看戏
 *   4. 有概率选择性沉默，避免「每句都回」的机器人感
 *
 * 所有阈值来自 config.json 的 access.chatter，不写死在代码里。
 */

const DEFAULT_CHATTER = {
  enabled: true,
  groupReplyRate: 0.55,      // 群里没被 @ 时，热话题的回复概率
  groupIdleReplyRate: 0.8,   // 群里冷场（只有一个人在说）时的回复概率
  cooldownMs: 25000,         // 同一个人连续发，两条之间最短间隔
  burstCooldownMs: 45000,    // 群里刚回过嘴，多少毫秒内不再插话
  busyThreshold: 4,          // 最近窗口里几条不同的人 → 判定为「热聊」，降低插话概率
  keepQuietOnTopics: [],     // 命中这些关键词的群话题直接不接（如自定义屏蔽词）
};

/** 私聊里明显是刷屏/无意义的消息 */
const SPAM_RE = /^([?.!！？。~～、\s]|哈{4,}|6{3,}|草{3,}|呵{3,})*$/;
/** 表情/空消息 */
const EMPTY_RE = /^\s*$/;

export function chatterConfig(config = {}) {
  return { ...DEFAULT_CHATTER, ...(config.access?.chatter || {}) };
}

/**
 * @param {object} evt       归一化事件
 * @param {object} opts
 * @param {object} opts.convo 当前会话状态（有 lastReplyAt / recentSenders）
 * @param {number} opts.now
 * @returns {{reply:boolean, reason:string}}
 */
export function shouldReply(evt, opts = {}) {
  const cfg = chatterConfig(opts.config);
  const now = opts.now ?? Date.now();
  const convo = opts.convo || {};
  const text = String(evt.text || '').trim();

  if (!cfg.enabled) return { reply: true, reason: 'gate-disabled' };
  if (EMPTY_RE.test(text) && !(evt.attachments || []).length) {
    return { reply: false, reason: 'empty' };
  }

  // 1) 点名：永远回
  if (evt.mentioned) return { reply: true, reason: 'mentioned' };
  if (evt.quotedBot) return { reply: true, reason: 'quoted-bot' };

  // 2) 私聊：默认回，纯刷屏不回
  if (evt.scene === 'c2c') {
    if (SPAM_RE.test(text) && text.length <= 6) return { reply: false, reason: 'c2c-spam' };
    return { reply: true, reason: 'c2c' };
  }

  // 3) 群聊没点名
  if (evt.scene === 'group') {
    if (cfg.keepQuietOnTopics.some((w) => w && text.includes(w))) {
      return { reply: false, reason: 'quiet-topic' };
    }
    // 刚回过嘴，冷却期内不插话
    if (convo.lastReplyAt && now - convo.lastReplyAt < cfg.burstCooldownMs) {
      return { reply: false, reason: 'burst-cooldown' };
    }
    // 话题冷清（最近只有 1~2 个人说话）→ 更愿意接
    const senders = evt.recentSenders || convo.recentSenders || [];
    const busy = new Set(senders).size >= cfg.busyThreshold;
    const rate = busy ? cfg.groupReplyRate * 0.5 : cfg.groupIdleReplyRate;
    const roll = Math.random();
    if (roll < rate) return { reply: true, reason: busy ? 'group-busy-hit' : 'group-idle-hit' };
    return { reply: false, reason: busy ? 'group-busy-skip' : 'group-idle-skip' };
  }

  // 4) 频道：只有 @ 才回
  return { reply: false, reason: 'channel-no-mention' };
}

/** 记录一次发言，用于冷却与「热聊」判断（就地修改 convo） */
export function noteIncoming(convo, evt, now = Date.now()) {
  convo.recentSenders = convo.recentSenders || [];
  if (evt.userId) {
    convo.recentSenders.push(evt.userId);
    if (convo.recentSenders.length > 12) convo.recentSenders.shift();
  }
  convo.lastIncomingAt = now;
  return convo;
}

export function noteReply(convo, now = Date.now()) {
  convo.lastReplyAt = now;
  convo.recentSenders = [];
  return convo;
}

/** 同一人连续刷的最短间隔（私聊里防轰炸） */
export function tooFast(convo, evt, cfg = DEFAULT_CHATTER, now = Date.now()) {
  if (!convo.lastIncomingAt || !convo.lastSenderAt) return false;
  if (evt.userId !== convo.lastSenderId) return false;
  return now - convo.lastIncomingAt < (cfg.cooldownMs || 0);
}
