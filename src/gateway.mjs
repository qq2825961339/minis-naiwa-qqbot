/**
 * QQ 官方 WebSocket 网关客户端（v2）
 * 流程：GET /gateway → wss:// URL → HELLO(10) 拿 heartbeat_interval
 *       → IDENTIFY(2) {token: "QQBot <access_token>", intents, shard}
 *       → READY(0) 拿 session_id → 定时 HEARTBEAT(1) 发心跳，d 为最后 seq
 *       → 断线后 RESUME(6) 续连，失败则重新 IDENTIFY
 */
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

const GATEWAY_URL = '/gateway';

// intents 位
export const INTENT = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,           // 频道 @机器人 的消息
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,          // 频道私信
  OPEN_FORUMS_EVENT: 1 << 18,
  AUDIO_OR_LIVE_CHANNEL_MEMBER: 1 << 19,
  GROUP_AND_C2C_EVENT: 1 << 25,     // 群 @机器人 + 私聊消息
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,   // 频道全量消息（需权限）
};

/** 基础权限：群 @ + 私聊（扫码创建的机器人默认只有这个） */
export const BASE_INTENTS = INTENT.GROUP_AND_C2C_EVENT | INTENT.INTERACTION;

/** 完整权限：频道 @ / 频道私信 / 频道全量 —— 需在开放平台单独申请，未开通时 IDENTIFY 会 4014 */
export const DEFAULT_INTENTS =
  INTENT.GROUP_AND_C2C_EVENT |
  INTENT.GUILD_MESSAGES |
  INTENT.DIRECT_MESSAGE |
  INTENT.PUBLIC_GUILD_MESSAGES |
  INTENT.INTERACTION;

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

export class QQGateway extends EventEmitter {
  constructor(api, { intents = DEFAULT_INTENTS, log = console.log } = {}) {
    super();
    this.api = api;
    this.intents = intents;
    this.intentsTried = new Set();   // 已试过且被平台拒绝的 intents
    this.intentsLocked = false;
    // 上次探测出的可用 intents 直接复用，避免每次启动都撞一次 4014
    try {
      const f = new URL('../.intents.json', import.meta.url);
      if (fs.existsSync(f)) {
        const saved = JSON.parse(fs.readFileSync(f, 'utf8')).intents;
        if (saved) { this.intents = saved; this.intentsLocked = true; }
      }
    } catch {}
    this.log = log;
    this.ws = null;
    this.sessionId = null;
    this.lastSeq = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.closed = false;
    this.attempt = 0;
  }

  async connect() {
    this.closed = false;
    const token = await this.api.getToken();
    const gw = await this.api.request('GET', GATEWAY_URL);
    const url = gw?.url;
    if (!url) throw new Error('获取 WebSocket 网关地址失败');
    this.log(`[ws] 连接 ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;
    let heartbeating = false;

    ws.on('open', () => this.log('[ws] 已连接，等待 HELLO'));

    ws.on('message', async (raw) => {
      let pkt;
      try { pkt = JSON.parse(raw.toString()); } catch { return; }
      const { op, d, s, t } = pkt;
      if (s !== undefined && s !== null) this.lastSeq = s;

      switch (op) {
        case OP.HELLO: {
          const interval = d?.heartbeat_interval || 41250;
          const tok = await this.api.getToken();
          if (this.sessionId && this.lastSeq !== null) {
            this.log(`[ws] RESUME session=${this.sessionId} seq=${this.lastSeq}`);
            ws.send(JSON.stringify({ op: OP.RESUME, d: { token: `QQBot ${tok}`, session_id: this.sessionId, seq: this.lastSeq } }));
          } else {
            this.log(`[ws] IDENTIFY intents=${this.intents}`);
            ws.send(JSON.stringify({ op: OP.IDENTIFY, d: { token: `QQBot ${tok}`, intents: this.intents, shard: [0, 1], properties: {} } }));
          }
          if (!heartbeating) {
            heartbeating = true;
            this.startHeartbeat(ws, interval);
          }
          break;
        }
        case OP.DISPATCH: {
          if (t === 'READY') {
            this.sessionId = d?.session_id || null;
            this.attempt = 0;
            this.log(`[ws] READY session=${this.sessionId} user=${d?.user?.username || d?.user?.id || ''}`);
            this.emit('ready', d);
          } else if (t === 'RESUMED') {
            this.attempt = 0;
            this.log('[ws] RESUMED');
            this.emit('resumed');
          } else {
            // 心跳/续连时收到 INVALID_SESSION 才算失败；这里只做事件分发
            this.emit('dispatch', t, d);
            this.emit(t, d);
          }
          break;
        }
        case OP.HEARTBEAT_ACK:
          break;
        case OP.RECONNECT:
          this.log('[ws] 服务端要求重连');
          this.scheduleReconnect(true);
          break;
        case OP.INVALID_SESSION:
          // 4014 = 机器人没有申请的权限点，或短时间内反复 IDENTIFY 被拒。
          // 只降级一次并记住结果，避免每次重连都撞一遍失败流程。
          if (this.intents !== BASE_INTENTS && !this.intentsLocked) {
            this.log(`[ws] INVALID_SESSION(${this.intents}) → 降级为群+私聊 intents=${BASE_INTENTS}`);
            this.intents = BASE_INTENTS;
            this.intentsLocked = true;
            this.saveIntents(BASE_INTENTS);
            this.attempt = 0;
          } else if (this.intentsLocked) {
            // 已经是可用集合还被拒：多数是限流，退避一下再来
            this.log('[ws] INVALID_SESSION（已用最小 intents，疑似限流），退避重试');
          } else {
            this.log('[ws] INVALID_SESSION，清空会话重新鉴权');
            this.sessionId = null;
            this.lastSeq = null;
            this.attempt = 0;
          }
          this.sessionId = null;
          this.lastSeq = null;
          this.scheduleReconnect(true);
          break;
        default:
          break;
      }
    });

    ws.on('close', (code) => {
      this.log(`[ws] 关闭 code=${code}`);
      this.stopHeartbeat();
      if (!this.closed) this.scheduleReconnect(false);
    });

    ws.on('error', (err) => {
      this.log(`[ws] 错误: ${err.message}`);
    });
  }

  startHeartbeat(ws, interval) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.lastSeq }));
    }, interval);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  scheduleReconnect(invalidate) {
    if (invalidate) { this.sessionId = null; this.lastSeq = null; }
    if (this.reconnectTimer) return;
    const delay = Math.min(60, 2 ** this.attempt) * 1000;
    this.attempt += 1;
    this.log(`[ws] ${delay / 1000}s 后重连（第 ${this.attempt} 次）`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (e) {
        this.log(`[ws] 重连失败: ${e.message}`);
        this.scheduleReconnect(false);
      }
    }, delay);
  }

  close() {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch {}
  }
}

/** 记住可用的 intents，下次启动直接用，不再撞 4014 */
QQGateway.prototype.saveIntents = function (intents) {
  try {
    const f = new URL('../.intents.json', import.meta.url);
    fs.writeFileSync(f, JSON.stringify({ intents, savedAt: new Date().toISOString() }));
  } catch {}
};
