/**
 * 音乐 —— 网易云搜索 + Meting 取音频（不下载、直传）
 *
 * 链路：歌名 → 网易云 search（免登录）→ id → Meting 302 → CDN mp3 → QQ
 *
 * 现实：正版热门歌被版权屏蔽，搜出来多是翻唱/纯音乐。
 *       能拿到什么算什么，拿不到就换下一个结果。
 */

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const METING = 'https://api.injahow.cn/meting/';
const DEFAULT = {
  tryCount: 6,          // 最多试几个搜索结果
  maxMB: 25,            // QQ 语音软限 20MB，留余量
  minMB: 1.5,           // 太小的多半是试听片段
  searchLimit: 10,
};

/** 用户是不是在点歌 */
const ASK_RE = /(放首|来首|听首|点首|唱首|放一首|来一首|听一首|放个歌|来首歌|听首歌|点歌|听音乐|放音乐|放点音乐|来点音乐)/;
/** 「换一首」 */
const NEXT_RE = /(换一首|换歌|下一首|再放一首|还有吗|听点别的|换个歌)/;

export function wantsMusic(text) {
  return ASK_RE.test(String(text || ''));
}
export function wantsNextMusic(text) {
  return NEXT_RE.test(String(text || ''));
}

/** 从「放首晴天」里抠歌名 */
export function extractSongName(text) {
  const t = String(text || '');
  const m = t.match(/(?:放首|放一首|来首|来一首|听首|听一首|点首|唱首|放个|来个)\s*([^\s，。,!！？?的]{1,16})/);
  if (m && m[1]) {
    // 「放首歌」「来首音乐」这类没具体歌名 → 返回空，走随机
    const kw = m[1].replace(/首歌|首音乐|音乐|歌/g, '').trim();
    if (!kw) return '';
    return kw;
  }
  // 兜底：去掉动词和称呼后剩下的
  const cleaned = t.replace(/奶蛙|你|我|吧|呢|啊|呀|放首|来首|听首|点首|唱首|放一首|来一首|听一首|放个歌|来首歌|听首歌|点歌|听音乐|放音乐|放点音乐|来点音乐|首歌|音乐|歌/g, '').trim();
  return cleaned.slice(0, 16);
}

/**
 * 搜歌，返回 [{ id, name, artist, duration }]
 */
export async function searchSong(keyword, { limit = 10, timeout = 15000 } = {}) {
  const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&limit=${limit}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(timeout),
    });
    const j = await r.json();
    const songs = j?.result?.songs || [];
    return songs.map((s) => ({
      id: s.id,
      name: String(s.name || '').slice(0, 40),
      artist: (s.artists || s.ar || []).map((a) => a.name).join('/').slice(0, 30),
      duration: Math.round((s.duration || 0) / 1000),
      album: (s.album || s.al || {}).name || '',
      cover: (s.album || s.al || {}).picUrl || (s.album || s.al || {}).artist?.img1v1Url || '',
    }));
  } catch {
    return [];
  }
}

/** 取音频直链（Meting 302 后的 CDN 地址） */
export async function getSongUrl(id, { timeout = 20000 } = {}) {
  try {
    const r = await fetch(`${METING}?type=url&id=${id}`, {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
    const loc = r.headers.get('location');
    if (!loc) return null;
    // 探一下体积，太大/拿不到就别发
    const h = await fetch(loc, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    const mb = Number(h.headers.get('content-length') || 0) / 1048576;
    return { url: loc, mb: Number(mb.toFixed(1)) };
  } catch {
    return null;
  }
}

/**
 * 一站式：给个关键词，拿一首能放的
 * @param {object} opts { exclude: [id...] } 排除已放过的
 * @returns {Promise<{url,name,artist,duration,id,mb}|null>}
 */
export async function findSong(keyword, opts = {}) {
  const cfg = { ...DEFAULT, ...opts };
  const hasKw = String(keyword || '').trim().length > 0;

  // 没给关键词就走「随便听听」的歌单
  let list = [];
  if (hasKw) {
    list = await searchSong(keyword, { limit: cfg.searchLimit });
  } else {
    list = await randomFromPlaylist(opts.playlist || '3778678'); // 网易云热歌榜
  }
  const exclude = new Set(opts.exclude || []);
  list = list.filter((s) => !exclude.has(s.id));

  for (const s of list.slice(0, cfg.tryCount)) {
    const u = await getSongUrl(s.id);
    if (!u) continue;
    if (u.mb && u.mb > cfg.maxMB) continue;
    if (u.mb && u.mb < cfg.minMB) continue;   // 试听片段，跳过换下一首
    return { ...s, ...u };
  }
  return null;
}

/** 从一个歌单里随机取一首（用于「随便放首歌」） */
async function randomFromPlaylist(playlistId) {
  try {
    const r = await fetch(`${METING}?type=playlist&id=${playlistId}`, {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000),
    });
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return [];
    // Meting 返回的 url 形如 .../meting/?type=url&id=12345，把 id 抠出来
    return arr.map((x) => {
      const id = String(x.url || '').match(/id=(\d+)/)?.[1];
      return id ? { id: Number(id), name: String(x.name || '').slice(0, 40), artist: String(x.artist || '').slice(0, 30), duration: Number(x.duration || 0) } : null;
    }).filter(Boolean).sort(() => Math.random() - 0.5);
  } catch {
    return [];
  }
}

// 自测：node music.mjs 晴天
if (import.meta.url === `file://${process.argv[1]}`) {
  const kw = process.argv[2] || '';
  const t0 = Date.now();
  const s = await findSong(kw);
  console.log(s
    ? `✅ ${s.name} - ${s.artist} (${s.duration}s, ${s.mb}MB, ${((Date.now() - t0) / 1000).toFixed(1)}s)\n   ${s.url.slice(0, 80)}...`
    : '❌ 没找到能放的');
}
