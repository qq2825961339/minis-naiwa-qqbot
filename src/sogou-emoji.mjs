/**
 * 搜狗表情包搜索
 *
 * 官方 napi 已被风控（返回 {"status":1,"info":"forbid"}），
 * 但结果页把数据放在 window.__INITIAL_STATE__.searchList.searchList 里，
 * 所以走「抓页面 + 解析 INITIAL_STATE」。
 *
 * 无需 cookie / 签名。图片直链 i0Xpiccdn.sogoucdn.com/<hash> 可直接下载。
 */

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** 搜表情，返回 [{thumb, url, title, gif, width, height}]，失败返回 [] */
export async function searchEmoji(keyword, { limit = 20, timeout = 20000 } = {}) {
  const url = `https://pic.sogou.com/pics?query=${encodeURIComponent(keyword)}&mode=15&start=0`;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ctrl.signal });
    if (!r.ok) return [];
    const html = await r.text();
    const m = html.match(/window\.__INITIAL_STATE__=(\{[\s\S]*?\});?\s*(?:window|<\/script>)/);
    if (!m) return [];
    const state = JSON.parse(m[1]);
    const list = state?.searchList?.searchList;
    if (!Array.isArray(list)) return [];
    return list
      .filter((it) => it && (it.thumbUrl || it.picUrl))
      .slice(0, limit)
      .map((it) => ({
        thumb: it.thumbUrl,
        url: it.oriPicUrl || it.picUrl,
        title: String(it.title || '').slice(0, 40),
        gif: /\.gif(\?|$)/i.test(it.oriPicUrl || it.picUrl || '') || it.gifpic === 1,
        width: it.width,
        height: it.height,
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(tm);
  }
}

/** 下载图片，返回 Buffer；限制大小防爆内存 */
export async function fetchEmoji(url, { maxBytes = 3 * 1024 * 1024, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > maxBytes) throw new Error(`文件过大 ${len}B`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`文件过大 ${buf.length}B`);
    return buf;
  } finally {
    clearTimeout(tm);
  }
}

/** 按文件头判断真实格式 */
export function sniffType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
