/**
 * B站短视频 —— 搜索 + 取 mp4 直链（不下载、不转码）
 *
 * 链路：搜索 → bvid → cid → playurl → mp4 直链 → 交给 QQ 直传
 * 限制：QQ 富媒体视频 file_type=2 软限制 30MB，超过会「富媒体文件上传超时」
 *       480P 下约 1 分钟 3~5MB，所以筛 5 分钟以内的视频
 */

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DEFAULT = {
  maxMinutes: 5,       // 超过这么长的不选（避免超 30MB）
  maxMB: 28,           // HEAD 探测到的体积上限
  minSeconds: 8,       // 太短的也不要
  tryCount: 5,         // 最多试几条
  qn: 32,              // 32=480P，体积小
};

/** 拿一个可用的 buvid3（B站接口必需） */
async function getBuvid() {
  try {
    const r = await fetch('https://www.bilibili.com', { headers: { 'User-Agent': UA } });
    const ck = r.headers.getSetCookie?.() || [];
    const m = ck.join(';').match(/buvid3=([^;]+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function secs(duration) {
  const p = String(duration || '0:0').split(':').map(Number);
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return 0;
}

/**
 * 搜一个短视频，返回 { url, title, duration, bvid, mb } 或 null
 */
export async function findVideo(keyword, opts = {}) {
  const cfg = { ...DEFAULT, ...opts };
  const exclude = new Set(opts.exclude || []);
  const sentBefore = new Set(opts.sent || []);
  const buvid = await getBuvid();
  const H = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: buvid ? `buvid3=${buvid}` : '' };

  // 1) 搜索
  let list = [];
  try {
    const r = await fetch(
      `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1`,
      { headers: H, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    list = (j.data?.result || []).filter((v) => {
      const s = secs(v.duration);
      return s >= cfg.minSeconds && s <= cfg.maxMinutes * 60;
    });
  } catch { return null; }
  if (!list.length) return null;

  // 2) 逐条试，直到拿到体积合适的 mp4
  for (const v of list.slice(0, cfg.tryCount)) {
    if (exclude.has(v.bvid) || sentBefore.has(v.bvid)) continue;   // 「换一个」时不重复
    try {
      const jv = await (await fetch(
        `https://api.bilibili.com/x/web-interface/view?bvid=${v.bvid}`, { headers: H, signal: AbortSignal.timeout(12000) })).json();
      const cid = jv.data?.cid;
      if (!cid) continue;

      const jp = await (await fetch(
        `https://api.bilibili.com/x/player/playurl?bvid=${v.bvid}&cid=${cid}&qn=${cfg.qn}&fnval=1&platform=html5&high_quality=1`,
        { headers: H, signal: AbortSignal.timeout(12000) })).json();
      const url = jp.data?.durl?.[0]?.url;
      if (!url) continue;

      // 3) HEAD 探体积
      let mb = 0;
      try {
        const h = await fetch(url, { method: 'HEAD', headers: H, signal: AbortSignal.timeout(10000) });
        mb = Number(h.headers.get('content-length') || 0) / 1048576;
      } catch { mb = 0; }

      if (mb && mb > cfg.maxMB) continue;

      return {
        url,
        title: String(v.title || '').replace(/<[^>]+>/g, ''),
        duration: v.duration,
        bvid: v.bvid,
        mb: Number(mb.toFixed(1)),
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** 判定用户是不是在要视频 */
export function wantsVideo(text) {
  return /(来个|发个|想看|找个|搜个|放个|来段|有没有)[^\s，。,!！]{0,10}视频/.test(String(text||''))
    || /(来段|来个)[^\s，。,!！]{1,8}的?$/.test(String(text||''));
}

/**
 * 从「发个可爱猫咪视频」里扣出搜索词 → 「可爱猫咪」
 * 扣不到就返回空字符串，由调用方兜底
 */
export function extractVideoKeyword(text) {
  const t = String(text || '');
  // 1. 去掉开头的动词和结尾的「视频」
  const m = t.match(/(?:来个|发个|想看|找个|搜个|放个|来段|有没有)\s*([^\s，。,!！]{0,12}?)\s*的?\s*视频/);
  if (m && m[1]) {
    let kw = m[1].replace(/^[的个一段]/, '').trim();
    // 去掉常见口头词，剩下的才是内容词
    kw = kw.replace(/^(给我|帮我|你|来|点|些|这种|那种|个|一)/g, '').replace(/^(点|些|的)/,'').trim();
    if (kw) return kw.slice(0, 10);
  }
  // 2. 整句话里找名词片段（去掉动词/称呼）
  const cleaned = t
    .replace(/奶蛙|你|我|吧|呢|啊|呀/g, '')
    .replace(/来个|发个|想看|找个|搜个|放个|来段|有没有|视频|一个|一段/g, '')
    .trim();
  return cleaned.slice(0, 10);
}

// 自测：node bili-video.mjs 猫
if (import.meta.url === `file://${process.argv[1]}`) {
  const kw = process.argv[2] || '猫';
  const t0 = Date.now();
  const v = await findVideo(kw);
  console.log(v
    ? `✅ ${v.title} | ${v.duration} | ${v.mb}MB | ${((Date.now() - t0) / 1000).toFixed(1)}s\n   ${v.url.slice(0, 90)}`
    : '❌ 没找到合适的视频');
}
