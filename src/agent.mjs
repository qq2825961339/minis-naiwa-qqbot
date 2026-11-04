/**
 * 调度核心：QQ 消息 → 会话隔离 → 调用 Minis Agent Loop → 回复 QQ
 *
 * 会话隔离：私聊按 openid、群聊按 group_openid、频道按 channel_id 各一个会话，
 *           内存历史 + 落盘，可选带上自己的"自引用记忆"由 Agent Loop 自己接管。
 *
 * Agent 调用方式（config.agent.mode）：
 *   "cli"      —— minis-model-use run（纯模型，无工具，最稳，默认）
 *   "loop"     —— minis-scheduled 在 Minis 里新开会话跑 Agent Loop，结果回投到当前会话
 * （"只要 Agent Loop 有工具、能干活"就走 loop；只想要纯聊天用 cli。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AgentBridge {
  constructor({ api, config, here, log = console.log }) {
    this.api = api;
    this.config = config;
    this.here = here;
    this.log = log;
    this.stateFile = path.join(here, '.state.json');
    this.groupsFile = path.join(here, 'groups.json');
    this.state = this.loadState();
    this.mergeGroups();        // 把 groups.json 里记录的群并入 access.groups
    this.queues = new Map();
    this.stats = { inbound: 0, outbound: 0, errors: 0, startedAt: Date.now() };
  }

  /** groups.json 是运行时登记表：启动时并入配置，配置里的显式值优先 */
  mergeGroups() {
    try {
      if (!fs.existsSync(this.groupsFile)) return;
      const known = JSON.parse(fs.readFileSync(this.groupsFile, 'utf8'));
      const g = (this.config.access.groups ||= {});
      let added = 0;
      for (const [id, info] of Object.entries(known)) {
        if (!g[id]) { g[id] = { requireMention: info.requireMention }; added++; }
      }
      if (added) this.log(`[groups] 已从 groups.json 载入 ${added} 个群设置`);
    } catch (e) {
      this.log(`[groups] 载入失败: ${e.message}`);
    }
  }

  loadState() {
    const empty = { version: 2, convos: {} };
    if (!fs.existsSync(this.stateFile)) return empty;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!s.convos) s.convos = {};
      return s;
    } catch (e) {
      // 文件损坏：备份后重建，不让一个坏 JSON 把历史全丢掉
      const bak = `${this.stateFile}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(this.stateFile, bak); } catch {}
      this.log(`[state] 状态文件损坏，已备份到 ${bak}，重新初始化`);
      return empty;
    }
  }

  /** 原子写入：先写临时文件再 rename，避免进程被 kill 时留下半个 JSON */
  saveState() {
    try {
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.stateFile);
      this._dirty = false;
    } catch (e) {
      this.log(`[state] 写入失败 ${e.message}`);
    }
  }

  /** 标记有改动，由定时器兜底落盘（防崩溃丢最后几轮） */
  markDirty() { this._dirty = true; }

  startAutoSave(intervalMs = 5000) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._dirty) this.saveState();
      this._historyTrimmed = false;
    }, intervalMs);
    this._timer.unref?.();
  }

  stopAutoSave() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }


  // ---------------- 会话键 ----------------
  key(evt) {
    if (evt.scene === 'group') {
      return (this.config.groupIsolation || 'group') === 'sender'
        ? `group:${evt.peerId}:${evt.userId}`
        : `group:${evt.peerId}`;
    }
    if (evt.scene === 'guild') return `guild:${evt.peerId}`;
    return `c2c:${evt.userId || evt.peerId}`;
  }

  convo(k) {
    if (!this.state.convos[k]) this.state.convos[k] = { history: [], sessionId: null, createdAt: Date.now() };
    return this.state.convos[k];
  }

  /** 群的最终策略：单群显式配置 > 通配符 "*" > 账户级默认 > true（仅 @ 回复） */
  groupPolicy(openid) {
    const a = this.config.access || {};
    const g = (a.groups || {})[openid] || {};
    const wild = (a.groups || {})['*'] || {};
    return {
      enabled: g.enabled ?? wild.enabled ?? true,
      requireMention: g.requireMention ?? wild.requireMention ?? a.defaultRequireMention ?? true,
    };
  }

  // ---------------- 访问控制 ----------------
  isAllowed(evt) {
    const a = this.config.access || {};
    if (evt.ttl < 0) return false;                       // 疑似重复推送
    const id = evt.userId;
    if ((a.allowFrom || []).length && !a.allowFrom.includes(id)) return false;
    if ((a.blockFrom || []).includes(id)) return false;
    if (evt.scene === 'group') {
      const p = this.groupPolicy(evt.peerId);
      if (!p.enabled) return false;
      if (p.requireMention && !evt.mentioned) {
        if (!evt.text) return false;
        this.log(`[gate] 群里未 @ 机器人，忽略（群 ${evt.peerId.slice(0, 8)}…）`);
        return false;
      }
    }
    return true;
  }

  // ---------------- 入口 ----------------
  async handle(evt) {
    const k = this.key(evt);
    const prev = this.queues.get(k) || Promise.resolve();
    const cur = prev.then(() => this._handle(evt)).catch((e) => {
      this.stats.errors += 1;
      this.log(`[agent] 处理失败: ${e.stack || e.message}`);
    });
    this.queues.set(k, cur);
    return cur;
  }

  async _handle(evt) {
    if (evt.scene === 'group') {
      this.log(`[group] openid=${evt.peerId} from=${evt.userId} @=${evt.mentioned} text=${(evt.text || '').slice(0, 30)}`);
      try {
        const p = this.groupPolicy(evt.peerId);
        pwrite(this.here, evt.peerId, p.requireMention, (this.config.access?.groups || {})[evt.peerId] ? 'config' : 'seen');
      } catch {}
    }
    if (!this.isAllowed(evt)) return;
    this.stats.inbound += 1;
    const k = this.key(evt);
    const text = (evt.text || '').trim();

    // 模式切换：精确匹配，不消耗模型调用。任务模式只允许私聊使用
    const MODE_ON = ['任务模式', '/task', '/agent'];
    const MODE_OFF = ['聊天模式', '/chat'];
    if (MODE_ON.includes(text) || MODE_OFF.includes(text)) {
      const c = this.convo(k);
      const wantTask = MODE_ON.includes(text);

      // 群里不支持任务模式
      if (wantTask && evt.scene !== 'c2c') {
        this.log(`[mode] 群里尝试切任务模式，已拒绝 (${evt.scene})`);
        return this.sendLong(evt, '任务模式只能在私聊里开 群里就用聊天');
      }

      const next = wantTask ? 'sessions' : 'cli';
      if (c.mode === next) {
        return this.sendLong(evt, next === 'sessions'
          ? '已经开着呢 直接说要干啥'
          : '本来就是聊天模式');
      }
      c.mode = next;
      c.minisSessionId = null;
      c.history = [];
      c.updatedAt = Date.now();
      this.saveState();
      this.log(`[mode] ${k} → ${next}`);
      return this.sendLong(evt, next === 'sessions'
        ? '切到任务模式了 能读文件能跑命令 会慢一点 发「聊天模式」切回来'
        : '切回聊天了 快一些');
    }

    // 内置指令
    if (['/new', '/reset'].includes(text)) {
      const c = this.convo(k);
      c.history = [];
      c.sessionId = null;
      c.minisSessionId = null;
      this.saveState();
      return this.sendLong(evt, '🧹 已开启新对话。');
    }
    if (text === '/ping') return this.sendLong(evt, '🏓 pong');
    if (text === '/help') {
      const c = this.convo(k);
      return this.sendLong(evt, [
        '/new 开启新对话', '/ping 探活', '/help 帮助',
        evt.scene === 'c2c'
          ? '任务模式 / 聊天模式 切换（当前：' + (c.mode === 'sessions' ? '任务' : '聊天') + '）'
          : '群里只支持聊天 任务模式要私聊',
        '直接发消息就行', '支持 @我 的群聊 / 频道',
      ].join('\n'));
    }
    if (!text && !(evt.attachments || []).length) return;

    this.log(`[in] ${evt.scene} user=${evt.userId} peer=${evt.peerId} len=${text.length} att=${(evt.attachments || []).length}`);

    const where = evt.scene === 'group' ? 'QQ 群聊' : evt.scene === 'guild' ? 'QQ 频道' : 'QQ 私聊';
    // 附件下载并本地识别；files 留给 sessions 模式直接传给视觉模型
    let attLine = '';
    let attFiles = [];
    if ((evt.attachments || []).length) {
      const desc = await this.describeAttachments(evt);
      attFiles = desc.files || [];
      attLine = desc.text ? `\n[用户发来了附件，本地识别结果]\n${desc.text}` : '';
    }
    const userLine = `[场景: ${where}]${attLine}\n${text || '(仅附件)'}`;
    evt.__files = attFiles;

    const c = this.convo(k);
    c.history.push({ role: 'user', content: userLine });
    c.updatedAt = Date.now();
    const keep = (this.config.agent?.historyTurns ?? 20) * 2;
    while (c.history.length > keep) c.history.shift();
    this.markDirty();
    this.saveState();          // 用户消息立刻落盘，崩了也不丢提问

    let answer = '';
    try {
      answer = await this.runAgent(k, evt, c, userLine);
    } catch (e) {
      this.stats.errors += 1;
      this.log(`[agent] 出错: ${e.message}`);
      // 模型缺失是配置问题，把完整引导直接发到 QQ，别让用户只看到一句失败
      if (/没有可调用的模型/.test(e.message)) {
        return this.sendLong(evt, [
          '我这边没配模型 现在回不了话',
          '',
          '去这里加一个：',
          '设置 → 模型分组 → 选中分组 → 添加模型',
          '',
          '加完跟管理员说一声重启就行',
        ].join('\n'));
      }
      return this.sendLong(evt, `⚠️ 处理失败：${e.message}`);
    }
    c.history.push({ role: 'assistant', content: answer || '' });
    c.updatedAt = Date.now();
    this.markDirty();
    this.saveState();
    if (!answer || !answer.trim()) return;
    await this.sendLong(evt, answer.trim());
  }

  // ---------------- Agent 调用 ----------------
  /** 附件目录维护：超过 N 天或总量超上限的旧文件删掉，避免 iPhone 存储被吃光 */
  cleanMedia(dir, { keepDays = 3, maxBytes = 200 * 1024 * 1024 } = {}) {
    try {
      const now = Date.now();
      let files = fs.readdirSync(dir).map((f) => {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        return { p, size: st.size, mtime: st.mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);

      for (const f of files) {
        if (now - f.mtime > keepDays * 86400_000) { fs.unlinkSync(f.p); f.deleted = true; }
      }
      files = files.filter((f) => !f.deleted);
      let total = files.reduce((s, f) => s + f.size, 0);
      for (let i = files.length - 1; i >= 0 && total > maxBytes; i--) {
        fs.unlinkSync(files[i].p);
        total -= files[i].size;
      }
    } catch (e) {
      this.log(`[media] 清理失败: ${e.message}`);
    }
  }

  /**
   * 下载附件 → 本地识别。
   * 返回 { text, files }：text 供纯文本模型使用，files 是已下载的真实路径（供 sessions 模式 --attach）
   */
  async describeAttachments(evt) {
    const dir = path.join(this.here, 'media');
    fs.mkdirSync(dir, { recursive: true });
    this.cleanMedia(dir);
    const out = [];
    const files = [];
    for (const [i, a] of (evt.attachments || []).entries()) {
      const m = /^image\//.test(a.contentType || '');
      const ext = m ? '.img' : '.bin';
      const file = path.join(dir, `${evt.msgId || Date.now()}-${i}${ext}`);
      try {
        const res = await fetch(a.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`下载失败 ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 20 * 1024 * 1024) throw new Error('文件过大');
        const head = buf.subarray(0, 12);
        // 按魔数修正扩展名（QQ 图片链接常不带扩展名）
        let real = file;
        if (head[0] === 0x89 && head[1] === 0x50) real = file.replace(/\.img$/, '.png');
        else if (head[0] === 0xff && head[1] === 0xd8) real = file.replace(/\.img$/, '.jpg');
        else if (head.subarray(0, 4).toString() === 'GIF8') real = file.replace(/\.img$/, '.gif');
        else if (head.subarray(8, 12).toString() === 'WEBP') real = file.replace(/\.img$/, '.webp');
        fs.writeFileSync(real, buf);
        files.push(real);
        this.log(`[media] 已下载 ${real} (${(buf.length / 1024).toFixed(0)}KB, ${a.contentType || '?'})`);

        if (/\.(png|jpg|gif|webp)$/.test(real)) {
          const r = await execFileP('apple-vision', ['analyze', real], { timeout: 60_000 }).catch((e) => ({ stdout: '' }));
          let info = {};
          try { info = JSON.parse(r.stdout); } catch {}
          const d = info.data || info;
          const ocr = String(d?.ocr?.text || '').trim();
          const labels = (d?.classification || [])
            .slice(0, 6).map((l) => l.label).filter(Boolean);
          const barcodes = (d?.barcodes || []).map((b) => b.payload).filter(Boolean);
          const faces = d?.faces?.count || 0;
          const parts = [];
          if (labels.length) parts.push(`画面内容可能是：${labels.join('、')}`);
          if (faces) parts.push(`检测到 ${faces} 张人脸`);
          if (ocr) parts.push(`图中文字：${ocr.slice(0, 800)}`);
          if (barcodes.length) parts.push(`二维码/条形码内容：${barcodes.join(' | ')}`);
          out.push(parts.length ? parts.join('\n') : `一张图片（${a.contentType}），未识别出文字或明显物体`);
        } else {
          out.push(`附件 ${path.basename(real)}（${a.contentType || '未知类型'}，${(buf.length / 1024).toFixed(0)}KB），已保存到 ${real}`);
        }
      } catch (e) {
        this.log(`[media] 处理失败: ${e.message}`);
        out.push(`附件处理失败：${e.message}`);
      }
    }
    return { text: out.join('\n---\n'), files };
  }

  async runAgent(k, evt, c, userLine) {
    let mode = c.mode || this.config.agent?.defaultMode || this.config.agent?.mode || 'cli';
    // 任务模式只允许私聊；群里或其他场景一律走聊天（兜底旧状态残留）
    if (mode === 'sessions' && evt.scene !== 'c2c') {
      this.log(`[mode] ${evt.scene} 强制使用聊天模式`);
      mode = 'cli';
      c.mode = 'cli';
      this.saveState();
    }
    if (mode === 'sessions') return this.runViaSession(k, evt, c, userLine);
    if (mode === 'loop') return this.runViaLoop(k, evt);

    const inputFile = path.join(this.here, '.tmp-input.json');
    const messages = c.history.map((m) => ({ role: m.role, content: m.content }));

    // 决定用哪个模型：配置写死 or 自动挑选
    const sel = this.config.agent?.model
      ? { entryId: this.config.agent.model, name: this.config.agent.model, vision: null }
      : await this.selectModel();

    // 图片：只有模型支持 image_input 才传，否则退回 OCR 文字（避免提供方报 400）
    let imgs = (evt.__files || []).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
    if (imgs.length && sel.vision === false) {
      this.log(`[vision] 当前模型不支持图片输入，改用文字描述`);
      imgs = [];
    }
    // 组装多模态内容；GIF 等不支持的格式先转成静态 JPG
    let multimodal = null;
    if (imgs.length) {
      const last = messages[messages.length - 1];
      const parts = [{ type: 'text', text: last?.content || '' }];
      for (const f of imgs) {
        try {
          const src = await this.normalizeImage(f);
          if (!src) continue;
          const b64 = fs.readFileSync(src.file).toString('base64');
          parts.push({ type: 'image_url', image_url: { url: `data:${src.mime};base64,${b64}` } });
        } catch (e) {
          this.log(`[vision] 读取图片失败 ${f}: ${e.message}`);
        }
      }
      if (parts.length > 1) {
        multimodal = parts;
        messages[messages.length - 1] = { role: 'user', content: parts };
        this.log(`[vision] 附带 ${imgs.length} 张图片（多模态）`);
      }
    }

    fs.writeFileSync(inputFile, JSON.stringify({ messages }));
    const model = sel.entryId;
    const args = ['run', '--model', model, '--input', inputFile,
      '--max-tokens', String(this.config.agent?.maxTokens ?? 2048)];
    // 人格注入（三级回退，旧配置也能自动生效）
    const personaFile = this.resolvePersona();
    if (personaFile) {
      args.push('--system-file', personaFile);
    } else if (this.config.agent?.systemPrompt) {
      args.push('--system', this.config.agent.systemPrompt);
    }

    try {
      const { stdout } = await execFileP('minis-model-use', args, { maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
      return this.extractText(stdout);
    } catch (e) {
      // 415 / Unsupported Media：模型不收这张图。去掉图片用文字重试一次，别把错误抛给用户
      const msg = String(e.stderr || e.message || '');
      if (multimodal && /415|Unsupported Media/i.test(msg)) {
        this.log('[vision] 模型拒收该图片（415），改用文字描述重试');
        const plain = c.history.map((m) => ({ role: m.role, content: m.content }));
        fs.writeFileSync(inputFile, JSON.stringify({ messages: plain }));
        const r2 = await execFileP('minis-model-use', args, { maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
        return this.extractText(r2.stdout);
      }
      throw e;
    }
  }

  /** 统一图片格式：GIF 取第一帧转 JPG，其他原样返回；返回 { file, mime } */
  async normalizeImage(file) {
    const tmp = path.join(this.here, 'media', `.norm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
    try {
      if (/\.gif$/i.test(file)) {
        await execFileP('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
          '-vf', 'select=eq(n\\,0)', '-vframes', '1', '-q:v', '3', '-y', tmp], { timeout: 30_000 });
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
          this.log(`[vision] GIF 已转静态 JPG（${(fs.statSync(tmp).size / 1024).toFixed(0)}KB）`);
          return { file: tmp, mime: 'image/jpeg' };
        }
        return null;
      }
      if (/\.(jpg|jpeg)$/i.test(file)) return { file, mime: 'image/jpeg' };
      if (/\.png$/i.test(file)) return { file, mime: 'image/png' };
      if (/\.webp$/i.test(file)) return { file, mime: 'image/webp' };
      return { file, mime: 'image/jpeg' };
    } catch (e) {
      this.log(`[vision] 格式转换失败: ${e.message}`);
      return null;
    }
  }

  /** Agent Loop 默认模型（minis-model-use list 的 entry_id），缓存 10 分钟 */
  /**
   * 自动选择模型：列出所有可调用模型，按偏好挑一个。
   * 偏好 vision → 优先 image_input；否则取第一个。
   * 结果缓存 10 分钟。返回 { entryId, modelId, vision }。
   */
  async selectModel(force = false) {
    const now = Date.now();
    if (!force && this._modelCache && now - this._modelCache.at < 600_000) return this._modelCache;

    const { stdout } = await execFileP('minis-model-use', ['list', '--all'], { timeout: 60_000 });
    const list = JSON.parse(stdout)?.data?.models || [];
    if (!list.length) {
      this.log('❌ 没有检测到可调用的模型');
      this.log('   请到 设置 → 模型分组 → Minis 运行时可调用的模型');
      this.log('   入口：minis://settings/model-groups');
      this.log('   加完确认它出现在 `minis-model-use list` 中');
      this.log('   加完执行：node run.mjs --check  验证');
      throw new Error('没有可调用的模型，请在 设置 → 模型分组 → Minis 运行时可调用的模型 里添加');
    }

    const prefer = this.config.agent?.modelPrefer || 'vision';
    let picked = null;
    if (prefer === 'vision') {
      const vis = list.filter((m) => (m.modalities || []).includes('image_input'));
      // 有多个视觉模型时，取上下文最大的（能力通常更全）
      picked = vis.sort((a, b) => (b.context_window || 0) - (a.context_window || 0))[0] || null;
      if (!picked) this.log('[model] 当前没有支持图片输入的模型，将退回纯文字模式');
    }
    if (!picked) picked = list[0];

    const vision = (picked.modalities || []).includes('image_input');
    const cache = {
      entryId: picked.entry_id,
      modelId: picked.model_id,
      name: picked.display_name || picked.model_id,
      vision,
      at: now,
    };
    this._modelCache = cache;
    this.log(`[model] 自动选中：${cache.name}（${vision ? '支持看图' : '纯文本'}，共 ${list.length} 个可选）`);
    return cache;
  }

  /** 兼容旧调用：只返回 entry_id */
  async defaultModel() {
    return (await this.selectModel()).entryId;
  }

  /**
   * 解析人格文件，三级回退：
   *   1. config.agent.persona 指定
   *   2. persona/ 下只有一个 .md 就直接用它（旧配置无 persona 字段也能生效）
   *   3. 都没有 → 返回 null，上层退回 systemPrompt
   */
  resolvePersona() {
    const dir = path.join(this.here, 'persona');
    const a = this.config.agent || {};

    if (a.persona) {
      const f = path.join(dir, `${a.persona}.md`);
      if (fs.existsSync(f)) return f;
      this.log(`[persona] 指定的 ${a.persona}.md 不存在，尝试自动发现`);
    }

    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
          .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
        if (files.length === 1) {
          const f = path.join(dir, files[0]);
          const name = files[0].replace(/\.md$/, '');
          if (a.persona !== name) {
            this.log(`[persona] 自动启用 persona/${files[0]}（config 未指定）`);
            a.persona = name;              // 记忆下来，避免每轮重复扫描
          }
          return f;
        }
        if (files.length > 1) {
          this.log(`[persona] persona/ 下有 ${files.length} 个人格，未指定就用第一个人格 ${files[0]}；建议在 config.json 里写 "persona"`);
          return path.join(dir, files.sort()[0]);
        }
      }
    } catch (e) {
      this.log(`[persona] 扫描失败: ${e.message}`);
    }
    return null;
  }

  extractText(stdout) {
    let data;
    try { data = JSON.parse(stdout); } catch { return stdout.trim(); }
    if (data?.ok === false) {
      throw new Error(data?.error?.message || 'minis-model-use 调用失败');
    }
    const d = data?.data ?? data;
    if (typeof d?.output_text === 'string' && d.output_text.trim()) return d.output_text.trim();
    if (typeof d?.text === 'string' && d.text.trim()) return d.text.trim();
    if (typeof d?.content === 'string' && d.content.trim()) return d.content.trim();
    const c = d?.choices;
    if (c?.[0]?.message?.content) return c[0].message.content;
    // 输出被截断（stop_reason=length）或结构异常时，别静默返回空
    if (d?.stop_reason === 'length') {
      this.log('[model] 输出达到 maxTokens 上限被截断，可能因人格提示词过长');
      throw new Error('回复太长被截断了，你换个问法我再答一次');
    }
    this.log(`[model] 无法解析返回结构: ${Object.keys(d || {}).join(', ')} (stop_reason=${d?.stop_reason || '-'})`);
    return '';
  }

  /**
   * sessions 模式：消息直接送进 Minis 会话执行，工具全开。
   * 速度优化：自适应轮询（400ms 起，逐步放宽）+ 按 updated_at 判定完成。
   */
  async runViaSession(k, evt, c, userLine) {
    let sid = c.minisSessionId;
    // 图片/文件直接挂给视觉模型，让它真的"看见"，而不是只读 OCR 文字
    const attachArgs = [];
    for (const f of (evt.__files || [])) attachArgs.push('--attach', f);
    if (attachArgs.length) this.log(`[sessions] 附带 ${attachArgs.length / 2} 个文件`);

    if (sid) {
      const r = await execFileP('minis-sessions-cli',
        ['send', userLine, '--session', sid, '--source', 'qqbot', ...attachArgs],
        { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }).catch((e) => ({ stdout: '', stderr: e.message }));
      let ok = false;
      try { ok = JSON.parse(r.stdout)?.ok !== false; } catch {}
      if (!ok) {
        this.log(`[sessions] 续聊失败，重建会话: ${(r.stderr || r.stdout || '').slice(0, 120)}`);
        sid = null;
      }
    }

    if (!sid) {
      const r = await execFileP('minis-sessions-cli',
        ['send', userLine, '--source', 'qqbot', ...attachArgs], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
      const j = JSON.parse(r.stdout);
      sid = j?.data?.session_id || j?.data?.data?.session_id;
      if (!sid) throw new Error('创建 Minis 会话失败');
      c.minisSessionId = sid;
      this.saveState();
      this.log(`[sessions] 新会话 ${sid.slice(0, 8)}…`);
    }

    return await this.waitSession(sid, k);
  }

  /** 自适应轮询：先快后慢；用 last_message 变化判定完成，不再额外空等一次 */
  async waitSession(sid, k, timeoutMs = 180_000) {
    const start = Date.now();
    let delay = 400;
    let sawRunning = false;
    let prevMsg = null;
    let stable = 0;

    while (Date.now() - start < timeoutMs) {
      await sleep(delay);
      delay = Math.min(2500, Math.round(delay * 1.6));

      let st;
      try {
        const r = await execFileP('minis-sessions-cli', ['status', '--id', sid], { timeout: 30_000 });
        const j = JSON.parse(r.stdout);
        st = j?.data?.data || j?.data;   // 可能是双层嵌套
      } catch (e) {
        continue;
      }
      if (!st || st.error) continue;

      if (st.is_running) {
        sawRunning = true;
        stable = 0;
        continue;
      }
      // 刚发起时可能还没置为 running，给 1.2 秒宽限
      if (!sawRunning && Date.now() - start < 1200) continue;

      const msg = String(st.last_message || '').trim();
      if (!msg) continue;
      // 文本没变过一次即认为稳定（比以前少等一轮）
      if (msg === prevMsg) {
        stable += 1;
        if (stable >= 1) return msg;
      } else {
        prevMsg = msg;
        stable = 0;
      }
    }
    this.log(`[sessions] 超时 session=${sid.slice(0, 8)}…`);
    return prevMsg || '⏳ 这个任务有点久，还在处理，稍后再问我结果。';
  }

  /**
   * 走 Minis Agent Loop：用 minis-scheduled 在 Minis 内新开会话执行任务，
   * 结果回投到 --session 指定的"收件箱"会话；bridge 轮询该会话取回回答再发到 QQ。
   */
  async runViaLoop(k, evt) {
    const inbox = this.config.agent?.inboxSession;
    if (!inbox) throw new Error('agent.mode=loop 需要配置 agent.inboxSession');
    const label = `qq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const basePrompt = this.config.agent?.loopPrompt
      || '用户通过 QQ 发来消息，请给出要发给用户的最终回复：\n{{msg}}';
    const userText = evt.text || '(无文本，可能是附件)';
    const taskPrompt = basePrompt.replace('{{msg}}', () => userText);

    const { stdout } = await execFileP('minis-scheduled', ['create', '--label', label,
      '--prompt', taskPrompt, '--trigger', 'once', '--after', '1s',
      '--target', 'follow-up', '--session', inbox], { timeout: 60_000 });
    let jobId = null;
    try { jobId = JSON.parse(stdout)?.data?.created?.id || null; } catch {}
    this.log(`[loop] 已派发 label=${label} job=${jobId}`);

    const answer = await this.waitInboxReply(inbox, label, jobId);
    if (!answer) return '⏳ 收到了，Agent 还在处理，稍等一下可以再发一条消息催我。';
    return answer;
  }

  /** 轮询收件箱会话，等到这个 job 的最终回答 */
  async waitInboxReply(inbox, label, jobId, timeoutMs = 110_000) {
    const start = Date.now();
    let seenTotal = await this.inboxTotal(inbox);
    while (Date.now() - start < timeoutMs) {
      if (jobId) {
        try {
          const { stdout } = await execFileP('minis-scheduled', ['list'], { timeout: 30_000 });
          const parsed = JSON.parse(stdout);
          const jobs = parsed?.data?.tasks || parsed?.data?.jobs || [];
          const job = (Array.isArray(jobs) ? jobs : []).find((j) => j.id === jobId || j.label === label);
          if (job) {
            const st = String(job.state || job.status || '').toLowerCase();
            if (job.lastFireOk === false && job.firedCount > 0) {
              return null;
            }
            if (st === 'done' || st === 'completed' || st === 'finished') {
              const msg = await this.inboxLastAnswer(inbox, seenTotal);
              if (msg) return msg;
            } else if (st.includes('fail') || st === 'cancelled') {
              return null;
            }
          }
        } catch (e) {
          this.log(`[loop] 查询任务状态失败: ${e.message}`);
        }
      }
      await sleep(2500);
    }
    return await this.inboxLastAnswer(inbox, seenTotal);
  }

  async inboxTotal(inbox) {
    try {
      const { stdout } = await execFileP('minis-sessions-cli', ['messages', '--id', inbox, '--limit', '1'], { timeout: 30_000 });
      return JSON.parse(stdout)?.data?.total || 0;
    } catch { return 0; }
  }

  async inboxLastAnswer(inbox, seenTotal) {
    try {
      const { stdout } = await execFileP('minis-sessions-cli',
        ['messages', '--id', inbox, '--limit', '6', '--full'], { timeout: 30_000 });
      const msgs = JSON.parse(stdout)?.data?.messages || [];
      const fresh = msgs.filter((m) => m.role === 'assistant');
      const last = fresh[fresh.length - 1];
      if (!last) return null;
      // 只有当回答是在本次派发之后产生时才采纳
      if (msgs.length <= seenTotal && seenTotal > 0) return null;
      let text = String(last.text || '');
      text = text.replace(/<agent_callback[\s\S]*?<\/agent_callback>/g, '').trim();
      return text || null;
    } catch { return null; }
  }

  // ---------------- 发送 ----------------
  async sendLong(evt, text) {
    const limit = this.config.limit?.textChunk ?? 1800;

    // 模型用 ||| 标示"分条发送"，模拟真人连发几条微信的节奏
    let parts = String(text).split(/\s*\|\|\|\s*/).map((s) => s.trim()).filter(Boolean);
    // 硬限制：最多两条，超出的合并进第二条，避免模型不听话连发
    const MAX = this.config.limit?.maxBubbles ?? 2;
    if (parts.length > MAX) {
      const head = parts.slice(0, MAX - 1);
      const merged = parts.slice(MAX - 1).join(' ');
      parts = [...head, merged];
      this.log(`[out] 分条超过 ${MAX} 条，已合并`);
    }
    const bubbles = parts.length > 1 ? parts : [String(text)];

    let seq = 1;
    for (const bubble of bubbles) {
      // 单条过长仍按原逻辑切块
      for (const chunk of splitText(bubble, limit)) {
        const payload = this.stripForQQ(chunk);
        try {
          let r;
          if (evt.scene === 'group') r = await this.api.sendGroup(evt.peerId, payload, evt.msgId, seq++);
          else if (evt.scene === 'guild') r = await this.api.sendChannel(evt.peerId, payload, evt.msgId);
          else r = await this.api.sendC2C(evt.peerId, payload, evt.msgId, seq++);
          this.stats.outbound += 1;
          if (r?.id) this.log(`[out] ${evt.scene}->${evt.peerId} id=${r.id} seq=${seq - 1}`);
        } catch (e) {
          this.stats.errors += 1;
          this.log(`[out] 发送失败: ${e.message}`);
        }
        if (bubbles.length > 1) await sleep(400);
      }
      // 条与条之间：按长度模拟打字节奏（0.6~2 秒）
      if (bubbles.length > 1) {
        const waitMs = Math.min(2000, Math.max(600, bubble.length * 90));
        await sleep(waitMs);
      }
    }
    if (bubbles.length > 1) this.log(`[out] 分 ${bubbles.length} 条发送`);
  }

  /** QQ 不渲染 markdown 表格等，做最小清理 */
  stripForQQ(t) {
    return t
      .replace(/^```[a-zA-Z]*\n?/gm, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '');
  }

  async sendMedia(evt, file, kind) {
    const { fileToDataUrl, guessFileType } = await import('./qqapi.mjs');
    const ft = kind ? Number(kind) : guessFileType(file);
    const peer = { kind: evt.scene === 'group' ? 'group' : 'c2c', id: evt.peerId };
    const fileInfo = await this.api.uploadFile(peer, ft, undefined, fileToDataUrl(file));
    if (evt.scene === 'group') return this.api.sendMediaGroup(evt.peerId, fileInfo, evt.msgId, 1);
    return this.api.sendMediaC2C(evt.peerId, fileInfo, evt.msgId, 1);
  }
}

/** 记录见过的群 openid，方便写白名单/按群配置 */
export function pwrite(here, openid, requireMention, source = 'seen') {
  const f = path.join(here, 'groups.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const prev = all[openid] || {};
  const now = new Date().toISOString();
  all[openid] = {
    requireMention: requireMention === undefined ? true : requireMention,
    source,                                   // config = 来自 config.json；seen = 仅观测到
    firstSeen: prev.firstSeen || now,
    lastSeen: now,
    seenCount: (prev.seenCount || 0) + 1,
  };
  // 原子写：避免半截 JSON 导致群设置全丢
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, f);
}

export function splitText(text, limit = 1800) {
  if (!text) return [];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}
