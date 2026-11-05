/**
 * qqbiaoqing 表情包搜索
 *
 * 为什么用它：图床 q.qqbiaoqing.com 没有防盗链，QQ 服务器能直接抓图（URL 直传可用）。
 * 发表情（soutula）有防盗链，QQ 抓不到；搜狗图源质量差。
 *
 * 站点没有搜索接口，但有 15 个情绪分类 + 分页，图片 alt 就是表情含义。
 * 所以策略：按关键词映射到分类 → 翻几页 → 在 alt 里匹配关键词 → 挑一张。
 */

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE = 'https://www.qqbiaoqing.com';

/** 分类 → 关键词倾向 */
const CATS = {
  xinuaile: '喜怒哀乐', gaoxiao: '搞笑', keai: '可爱', egao: '恶搞',
  shouhui: '手绘', wenzi: '文字', dongtai: '动态', dongman: '动漫',
  jingdian: '经典', gaoguai: '搞怪', gexing: '个性', linglei: '另类',
  aiqing: '爱情', kongbu: '恐怖', tongnian: '童年',
};

/** 关键词 → 优先查的分类 */
const KEYWORD_CAT = {
  笑哭: ['gaoxiao', 'xinuaile'], 笑: ['gaoxiao'], 哈哈: ['gaoxiao'],
  无语: ['xinuaile', 'gaoguai'], 离谱: ['egao', 'gaoguai'], 服了: ['xinuaile'],
  生气: ['xinuaile'], 开心: ['xinuaile', 'keai'], 哭: ['xinuaile'],
  抱抱: ['aiqing', 'keai'], 爱你: ['aiqing'], 晚安: ['keai'], 早安: ['keai'],
  牛: ['gaoxiao', 'jingdian'], 震惊: ['gaoxiao'], 害怕: ['kongbu'],
  摆烂: ['egao'], 累了: ['xinuaile'], 困: ['keai'],
  问号: ['wenzi'], 好的: ['wenzi'], 告辞: ['gaoxiao'],
};

const NOISE = /(首页|公众号|logo|广告|下载|APP|微信|二维码)/i;

function strip(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

/** 抓一页分类，返回 [{url, title, gif}] */
async function fetchCategoryPage(cat, page = 1) {
  const url = page === 1 ? `${BASE}/${cat}/` : `${BASE}/${cat}/${page}.html`;
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!r.ok) return [];
    const html = await r.text();
    const items = [];
    const re = /<img[^>]*src="(https:\/\/q\.qqbiaoqing\.com\/[^"]+)"[^>]*alt="([^"]*)"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) {
      const [, src, alt] = m;
      if (NOISE.test(alt)) continue;
      items.push({
        url: src,
        thumb: src,
        title: strip(alt).slice(0, 30),
        gif: /\.gif(\?|$)/i.test(src),
      });
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(tm);
  }
}

/**
 * 搜索：关键词 → 分类 → 翻页 → 匹配 alt
 * @returns [{url, title, gif}]
 */
export async function searchEmoji(keyword, { limit = 12, pages = 20 } = {}) {
  const kw = String(keyword || '').trim().slice(0, 4);
  if (!kw) return [];

  // 关键词第一个字用来选分类
  const pick = KEYWORD_CAT[kw] || KEYWORD_CAT[kw.slice(0, 1)] || null;
  const order = pick || Object.keys(CATS).slice(0, 4);

  const exact = [];
  const loose = [];

  for (const cat of order) {
    for (let p = 1; p <= pages; p++) {
      const list = await fetchCategoryPage(cat, p);
      if (!list.length) break;
      for (const it of list) {
        if (it.title.includes(kw)) exact.push(it);
        else loose.push(it);
      }
      if (exact.length >= limit) break;
    }
    if (exact.length >= limit) break;
  }

  // 有精确命中就只用精确的；否则退回宽松结果（同分类下的图）
  const out = exact.length ? exact : loose.slice(0, limit * 2);
  return out.slice(0, limit);
}

export function sniffType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

// 自测：node qqbiaoqing.mjs 笑哭
if (import.meta.url === `file://${process.argv[1]}`) {
  const kw = process.argv[2] || '笑哭';
  const list = await searchEmoji(kw, { limit: 8 });
  console.log(`「${kw}」共 ${list.length} 条`);
  for (const e of list) console.log(` ${e.gif ? 'GIF' : 'IMG'} ${e.title}\n     ${e.url}`);
}
