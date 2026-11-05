/**
 * 奶蛙语音模块 —— edge-tts 合成
 *
 * 触发规则（config.access.voice）：
 *   1. 被要求时必发：命中「说句话/语音/念一下」等关键词
 *   2. 概率触发：普通对话每 N 条随机发一条
 *   3. 情绪变化：按回复内容调语速/音调
 *
 * 音色固定的原因：云夏（Cartoon，偏萌男声），与奶蛙人设一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const DEFAULT = {
  enabled: true,
  voice: 'zh-CN-YunxiaNeural',
  rate: '+8%',           // 基础语速
  pitch: '+0Hz',         // 基础音调
  gain: 2.2,             // 音量倍数（edge-tts 输出偏小）
  everyN: 3,             // 每 N 条回复随机发 1 条语音
  moodTrigger: true,     // 情绪强烈时额外触发
  moodChance: 0.5,       // 情绪触发概率
  maxChars: 60,          // 超过这个长度不合成（太长像念稿）
  timeoutMs: 60000,
  keepAudio: false,      // 是否保留合成产物
};

/** 明确要求语音的说法 */
const ASK_RE = /(说句话|说一句|说两句|发语音|发个语音|语音(一下|发|说|消息)?|念给我|念一下|读一下|读给我|用声音|出个声|听听你声音|你.{0,4}声音|来.{0,2}语音|听听你说)/;

/** 情绪档位：语速、音调偏移 */
const MOODS = [
  { name: 'angry', test: /(傻逼|滚|烦不烦|别废话|你才|闭嘴|有病|恼火|生气)/, rate: '+20%', pitch: '+10Hz' },
  { name: 'happy', test: /(笑死|哈哈|笑不活|离谱|绝了|太强|牛|爽|乐)/, rate: '+15%', pitch: '+5Hz' },
  { name: 'soft', test: /(别想太多|慢慢来|会好的|难受|心疼|抱抱|不容易|歇|别急|没关系)/, rate: '-10%', pitch: '-5Hz' },
];

export function voiceConfig(config = {}) {
  return { ...DEFAULT, ...(config.access?.voice || {}) };
}

/** 判断这条要不要发语音，返回 { want, reason } */
export function shouldSpeak(userText, replyText, cfg, counter) {
  if (!cfg.enabled) return { want: false, reason: 'disabled' };
  const parsed = parseVoice(replyText);
  // 模型主动给了语音内容 → 直接发
  if (parsed.speech) return { want: true, reason: parsed.pure ? 'model-pure' : 'model-mixed' };

  const text = String(replyText || '').trim();
  if (!text) return { want: false, reason: 'empty' };

  // 1) 被要求 → 必发（但太长的自动截断）
  if (ASK_RE.test(String(userText || ''))) return { want: true, reason: 'asked' };

  // 2) 太长不适合语音
  if ([...text].length > cfg.maxChars) return { want: false, reason: 'too-long' };

  // 3) 情绪强烈 → 额外概率触发（生气/大笑/安慰时更容易被念出来）
  if (cfg.moodTrigger) {
    const mood = pickMood(text);
    if (mood.name !== 'normal' && Math.random() < (cfg.moodChance ?? 0.5)) {
      return { want: true, reason: `mood-${mood.name}` };
    }
  }

  // 4) 计数概率触发
  if (counter % cfg.everyN === 0) return { want: true, reason: 'random' };
  return { want: false, reason: 'skip' };
}


/**
 * 解析回复里的语音标记
 *   "♪♪在呢 有啥事"     → 纯语音
 *   "行|||♪听到了吗"     → 文字 + 语音
 *   "那确实挺累的"        → 纯文字
 */
export function parseVoice(reply) {
  const raw = String(reply || '');
  // 纯语音：♪ 出现在最前面
  const pure = raw.match(/^\s*♪{1,2}\s*([\s\S]+)$/);
  if (pure) return { text: '', speech: pure[1].trim(), pure: true };

  // 文字 + 语音：♪ 在中间
  const mixed = raw.match(/^([\s\S]*?)\s*♪{1,2}\s*([\s\S]+)$/);
  if (mixed) {
    return { text: mixed[1].trim().replace(/\|{2,}\s*$/, ''), speech: mixed[2].trim(), pure: false };
  }
  return { text: raw.trim(), speech: '', pure: false };
}

/** 按回复内容判断情绪档 */
export function pickMood(replyText) {
  const t = String(replyText || '');
  for (const m of MOODS) if (m.test.test(t)) return m;
  return { name: 'normal', rate: DEFAULT.rate, pitch: DEFAULT.pitch };
}

/** 去掉标点、||| 分隔符、表情标签，让朗读顺一点 */
export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/\[表情[:：][^\]]*\]/g, '')
    .replace(/\|{2,}/g, '，')
    .replace(/[「」《》【】]/g, '')
    .replace(/[。！？；]+$/g, '')
    .trim();
}

/**
 * 合成语音，返回本地音频路径
 * @returns {Promise<string|null>}
 */
export async function synthesize(text, cfg, outDir) {
  const say = cleanForSpeech(text);
  if (!say) return null;

  const mood = pickMood(text);
  const rate = mood.rate || cfg.rate;
  const pitch = mood.pitch || cfg.pitch;

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const raw = path.join(outDir, `.tts-${stamp}.mp3`);
  const out = path.join(outDir, `voice-${stamp}.mp3`);

  try {
    // 注意：rate/pitch 取负值（如 -10%）时不能拆成两个参数，必须用 --opt=value 形式
    await execFileP('edge-tts', [
      `--voice=${cfg.voice}`,
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      `--text=${say}`,
      `--write-media=${raw}`,
    ], { timeout: cfg.timeoutMs, maxBuffer: 4 * 1024 * 1024 });

    if (!fs.existsSync(raw) || fs.statSync(raw).size < 800) return null;

    // QQ 那边音量偏小，统一放大到正常水平；顺带转成 44.1k 提高兼容性
    await execFileP('ffmpeg', [
      '-y', '-i', raw,
      '-af', `volume=${cfg.gain}`,
      '-ar', '44100', '-b:a', '96k',
      out,
    ], { timeout: cfg.timeoutMs });

    return fs.existsSync(out) ? out : null;
  } catch (e) {
    return null;
  } finally {
    try { fs.unlinkSync(raw); } catch {}
  }
}

/** 清理过期语音文件（默认只留最近 1 小时） */
export function cleanupVoices(dir, maxAgeMs = 3600 * 1000) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

// 命令行自测：node voice.mjs "要说的话"
if (process.argv[1] && process.argv[1].endsWith('voice.mjs')) {
  const text = process.argv[2] || '那确实挺累的 早点睡吧';
  const cfg = voiceConfig({});
  const dir = '/var/minis/attachments/voice-test';
  console.log('情绪档:', pickMood(text).name);
  console.log('判定:', shouldSpeak('说句话', text, cfg, 1));
  console.log('朗读文本:', cleanForSpeech(text));
  const t0 = Date.now();
  const f = await synthesize(text, cfg, dir);
  console.log(f ? `✅ ${f}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${Math.round(fs.statSync(f).size / 1024)}KB` : '❌ 合成失败');
}
