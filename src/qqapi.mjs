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
  sendC2C(openid, content, msgId, msgSeq) {
    const body = { content, msg_type: 0, msg_id: msgId };
    if (msgSeq) body.msg_seq = msgSeq;
    return this.request('POST', `/v2/users/${openid}/messages`, { body });
  }

  /** 群聊发送 */
  sendGroup(groupOpenid, content, msgId, msgSeq) {
    const body = { content, msg_type: 0, msg_id: msgId };
    if (msgSeq) body.msg_seq = msgSeq;
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
    if (fileData) { delete body.url; body.file_data = fileData; }
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
