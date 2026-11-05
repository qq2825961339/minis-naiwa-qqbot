/**
 * QQ 开放平台 API 最小客户端
 * 文档：https://bot.q.qq.com/wiki/
 * - 鉴权：AppID:AppSecret 换 access_token，有效期约 7200s，提前 60s 刷新
 * - 鉴权头：Authorization: QQBot <access_token>
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

export class QQApi {
  constructor({ appId, appSecret, log = console.log }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.log = log;
    this.token = null;
    this.tokenExpire = 0;
    this.tokenPromise = null;
  }

  async getToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpire) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
      });
      const data = await res.json();
      if (!data.access_token) {
        throw new Error(`获取 access_token 失败: ${JSON.stringify(data)}`);
      }
      this.token = data.access_token;
      const ttl = Number(data.expires_in || 7200);
      this.tokenExpire = Date.now() + Math.max(60, ttl - 60) * 1000;
      this.log(`[token] 已刷新，有效期 ${ttl}s`);
      return this.token;
    })();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  async request(method, url, { body, retry = true } = {}) {
    const token = await this.getToken();
    const res = await fetch(API + url, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
        'X-Union-Appid': this.appId,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status === 401 && retry) {
      this.log('[token] 401，强制刷新后重试');
      await this.getToken(true);
      return this.request(method, url, { body, retry: false });
    }
    if (!res.ok) {
      throw new Error(`QQ API ${method} ${url} -> ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    }
    return data;
  }

  /** 私聊发送：msg_id → 被动回复；不传 → 主动消息 */
  sendC2C(openid, content, msgId, msgSeq, refId) {
    const body = { content, msg_type: 0, msg_id: msgId };
    if (msgSeq) body.msg_seq = msgSeq;
    return this.request('POST', `/v2/users/${openid}/messages`, { body });
  }

  /** 群聊发送 */
  sendGroup(groupOpenid, content, msgId, msgSeq, refId) {
    const body = { content, msg_type: 0, msg_id: msgId };
    if (msgSeq) body.msg_seq = msgSeq;
    // 引用回复：refId 来自消息事件 message_scene.ext 里的 msg_idx
    if (refId) body.message_reference = { message_id: refId };
    return this.request('POST', `/v2/groups/${groupOpenid}/messages`, { body });
  }

  /** 频道文字子频道发送 */
  sendChannel(channelId, content, msgId) {
    const body = { content, msg_id: msgId, msg_type: 0 };
    return this.request('POST', `/channels/${channelId}/messages`, { body });
  }

  /** 富媒体上传（图片/语音/视频/文件统一走 files 接口，返回 file_info） */
  async uploadFile(peer, fileType, url, fileData) {
    const { kind, id } = peer; // kind: c2c | group
    const target = kind === 'group' ? `/v2/groups/${id}/files` : `/v2/users/${id}/files`;
    const body = { file_type: fileType, url, srv_send_msg: false };
    if (fileData) {
      delete body.url;
      // QQ 要求纯 base64，不能带 data:image/jpeg;base64, 前缀（带了报 40011000）
      body.file_data = String(fileData).replace(/^data:[^;,]+;base64,/, '');
    }
    const r = await this.request('POST', target, { body });
    return r?.file_info;
  }

  /** 发送富媒体消息（需要有 file_info） */
  sendMediaC2C(openid, fileInfo, msgId, msgSeq) {
    return this.request('POST', `/v2/users/${openid}/messages`, {
      body: { msg_type: 7, media: { file_info: fileInfo }, msg_id: msgId, msg_seq: msgSeq },
    });
  }

  sendMediaGroup(groupOpenid, fileInfo, msgId, msgSeq) {
    return this.request('POST', `/v2/groups/${groupOpenid}/messages`, {
      body: { msg_type: 7, media: { file_info: fileInfo }, msg_id: msgId, msg_seq: msgSeq },
    });
  }


  /** ARK 卡片（msg_type=3）。单聊/群聊都走同一个结构 */
  sendArkC2C(openid, ark, msgId, msgSeq) {
    const body = { msg_type: 3, ark };
    if (msgId) body.msg_id = msgId;
    if (msgSeq) body.msg_seq = msgSeq;
    return this.request('POST', `/v2/users/${openid}/messages`, { body });
  }

  sendArkGroup(groupOpenid, ark, msgId, msgSeq) {
    const body = { msg_type: 3, ark };
    if (msgId) body.msg_id = msgId;
    if (msgSeq) body.msg_seq = msgSeq;
    return this.request('POST', `/v2/groups/${groupOpenid}/messages`, { body });
  }

  /** 生成「文本 + 缩略图」音乐卡片（模板 24） */
  static musicArk({ title, desc, img, link, subtitle = '网易云音乐' }) {
    return {
      template_id: 24,
      kv: [
        { key: '#DESC#', value: '音乐' },
        { key: '#PROMPT#', value: '奶蛙点歌' },
        { key: '#TITLE#', value: String(title || '').slice(0, 30) || '未知歌曲' },
        { key: '#METADESC#', value: String(desc || '').slice(0, 40) },
        { key: '#IMG#', value: img || 'https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg' },
        { key: '#LINK#', value: link || 'https://music.163.com' },
        { key: '#SUBTITLE#', value: subtitle },
      ],
    };
  }


  /** 图文卡片（msg_type=8，不需 ARK 权限） */
  sendCardC2C(openid, card, msgId, msgSeq) {
    const body = { msg_type: 8, card };
    if (msgId) body.msg_id = msgId;
    if (msgSeq) body.msg_seq = msgSeq;
    return this.request('POST', `/v2/users/${openid}/messages`, { body });
  }

  sendCardGroup(groupOpenid, card, msgId, msgSeq) {
    const body = { msg_type: 8, card };
    if (msgId) body.msg_id = msgId;
    if (msgSeq) body.msg_seq = msgSeq;
    return this.request('POST', `/v2/groups/${groupOpenid}/messages`, { body });
  }

  /** 音乐用图文卡片 */
  static musicCard({ title, desc, img, link }) {
    return {
      type: 'tuwen',
      content: {
        title: String(title || '').slice(0, 50) || '未知歌曲',
        description: String(desc || '').slice(0, 200),
        url: link || 'https://music.163.com',
        pic_url: img || 'https://p2.music.126.net/6y-UleORITEDbvrOLV0Q8A==/5639395138885805.jpg',
      },
    };
  }

  /** 生成"正在输入"（频道用） */
  typingChannel(channelId) {
    return this.request('POST', `/channels/${channelId}/typing`);
  }
}

// ---------------- 本地文件 → data URL（base64，供 file_data 上传） ----------------
export function fileToDataUrl(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.silk': 'audio/silk',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.pdf': 'application/pdf', '.txt': 'text/plain',
  }[ext] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 按扩展名猜 QQ 的 file_type：1 图片 2 视频 3 语音 4 文件 */
export function guessFileType(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 1;
  if (['.mp4', '.mov'].includes(ext)) return 2;
  if (['.mp3', '.wav', '.silk'].includes(ext)) return 3;
  return 4;
}
