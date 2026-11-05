/**
 * 发表情（fabiaoqing.com）表情包搜索
 *
 * 比搜狗的图源准得多：搜狗返回全网图片（大量新闻配图），
 * 发表情是专门的表情包站，结果标题基本都带「XX表情」。
 *
 * 无需 cookie / 签名；图片直链 img.soutula.com 可直接下载，
 * gif/jpg 都有（搜狗那边几乎拿不到 gif）。
 */

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://www.fabiaoqing.com';

/** 去掉广告条、首页链接这类噪声 */
const NOISE = /(首页|公众号|微信|关注|下载APP|APP下载)/;

/**
 * 搜表情，返回 [{thumb, url, title, gif}]
 * @param {string} keyword 搜索词（2~4 字最佳）
 */
export async function searchEmoji(keyword, { limit = 20, timeout = 25000 } = {}) {
  const url = `${BASE}/search/bqb/keyword/${encodeURIComponent(keyword)}`;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ctrl.signal });
    if (!r.ok) return [];
    const html = await r.text();

    // 结果块：<a href="/biaoqing/detail/id/xxx.html" title="标题">
    //          <img data-original="https://img.soutula.com/bmiddle/xxx" src="懒加载占位" title="标题">
    const items = [];
    const re = /<a href="([^"]*\/biaoqing\/detail\/[^"]*)" title="([^"]*)">[\s\S]{0,800}?data-original="(https?:\/\/img\.soutula\.com\/[^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      const [, , title, src] = m;
      if (NOISE.test(title)) continue;
      const full = src.replace('/bmiddle/', '/large/').replace('/middle/', '/large/');
      items.push({
        thumb: full,
        url: full,
        title: title.slice(0, 40),
        gif: /\.gif(\?|$)/i.test(full),
      });
      if (items.length >= limit) break;
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(tm);
  }
}

/** 下载图片（本地校验用，线上走 URL 直传不需要） */
export async function fetchEmoji(url, { maxBytes = 3 * 1024 * 1024, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: BASE + '/' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`文件过大 ${buf.length}B`);
    return buf;
  } finally {
    clearTimeout(tm);
  }
}

export function sniffType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

// 命令行自测
if (import.meta.url === `file://${process.argv[1]}`) {
  const kw = process.argv[2] || '笑哭';
  const list = await searchEmoji(kw, { limit: 8 });
  console.log(`「${kw}」共 ${list.length} 条`);
  for (const e of list) console.log(` ${e.gif ? 'GIF' : 'IMG'} ${e.title || '(无题)'}\n     ${e.thumb}`);
}
