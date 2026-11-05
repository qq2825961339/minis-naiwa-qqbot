/**
 * 群聊「是不是在跟我说话」判定
 *
 * 判定顺序（先硬规则，再软判断）：
 *   1. @ / 引用奶蛙 / 叫名字        → 必回
 *   2. 纯刷屏、纯表情、别人之间的对话  → 不回
 *   3. 在接奶蛙上一句 / 冷场有人抛话   → 回
 *
 * 返回 { action: 'reply' | 'emoji' | 'silent', reason }
 */

const SPAM_RE = /^([?.!！？。~～、\s]|哈{4,}|6{3,}|草{3,}|呵{3,})*$/;
const EMOJI_ONLY_RE = /^[\p{Emoji}\s]+$/u;
/** 别人在互相说话的特征 */
const TO_OTHER_RE = /(@[^\s]{1,12}|[回问][复你]一下|[Aa]哥|[Bb]姐|老[板板])/;

export function judgeGroup(evt, ctx = {}) {
  const text = String(evt.text || '').trim();
  const {
    botName = '奶蛙',
    lastSpeaker = '',        // 上一条发言者：'bot' | 'other'
    lastBotAt = 0,           // 奶蛙上次说话时间
    quietMs = 5 * 60 * 1000, // 冷场判定：超过 5 分钟没人说话
    now = Date.now(),
  } = ctx;

  // ---- 1. 明确冲着奶蛙来的 ----
  if (evt.mentioned) return { action: 'reply', reason: 'mentioned' };
  if (evt.quotedBot) return { action: 'reply', reason: 'quoted-bot' };
  if (text.includes(botName)) return { action: 'reply', reason: 'called-by-name' };

  // ---- 2. 明显不用接的 ----
  if (!text && !(evt.attachments || []).length) return { action: 'silent', reason: 'empty' };
  if (SPAM_RE.test(text) && text.length <= 6) return { action: 'silent', reason: 'spam' };
  if (EMOJI_ONLY_RE.test(text)) {
    const b = Number.isFinite(ctx.busyChance) ? ctx.busyChance : 0.30;
    if (Math.random() < b * 0.5) return { action: 'reply', reason: 'butt-in-emoji' };
    return { action: 'silent', reason: 'emoji-only' };
  }
  // 别人在互相聊：大多数时候不插嘴，但偶尔插一句才像真人
  const busy = Number.isFinite(ctx.busyChance) ? ctx.busyChance : 0.30;
  if (TO_OTHER_RE.test(text) && !text.includes(botName)) {
    if (Math.random() < busy) return { action: 'reply', reason: 'butt-in-talking-to-other' };
    return { action: 'silent', reason: 'talking-to-other' };
  }
  // 普通闲聊、跟自己无关：也有概率顺手接一句
  if (Math.random() < busy) return { action: 'reply', reason: 'butt-in-casual' };
  return { action: 'silent', reason: 'casual-skip' };

  // ---- 3. 在接奶蛙的话 ----
  if (lastSpeaker === 'bot' && now - lastBotAt < 3 * 60 * 1000) {
    return { action: 'reply', reason: 'following-bot' };
  }

  // ---- 4. 冷场：很久没人说话，有人抛了一句 ----
  if (ctx.lastAnyAt && now - ctx.lastAnyAt > quietMs) {
    return { action: 'reply', reason: 'cold-start' };
  }


}

/** 人味程度：给回复选形式 */
export function decideForm(judge, replyLen) {
  if (judge.action === 'reply') return 'normal';
  if (judge.action === 'emoji') return 'emoji-only';
  return 'silent';
}

// 自测
if (process.argv[1] && process.argv[1].endsWith('group-judge.mjs')) {
  const cases = [
    [{ mentioned: true, text: '奶蛙在吗' }, {}, '被 @'],
    [{ text: '奶蛙你咋看' }, {}, '叫名字'],
    [{ text: '哈哈哈哈' }, {}, '纯刷屏'],
    [{ text: '😂😂😂' }, {}, '纯表情'],
    [{ text: '@小明 你去不去' }, {}, '在对别人说'],
    [{ text: '今天好累啊' }, { lastSpeaker: 'bot', lastBotAt: Date.now() - 30000 }, '接奶蛙话'],
    [{ text: '有人吗' }, { lastAnyAt: Date.now() - 10 * 60 * 1000 }, '冷场开场'],
    [{ text: '这个游戏挺好玩的' }, {}, '模棱两可'],
  ];
  for (const [evt, ctx, label] of cases) {
    const r = judgeGroup({ mentioned: false, attachments: [], ...evt }, ctx);
    console.log(`${label.padEnd(12)} → ${r.action.padEnd(7)} (${r.reason})`);
  }
}
