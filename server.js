/**
 * YiDimension IM Gateway Server (Full Skeleton)
 * Path on server: /www/wwwroot/yidimension/server.js
 *
 * Responsibilities:
 *  - HTTP API: /health, /api/status, /api/login, /api/reinit, /api/send-command
 *  - WebSocket gateway: connection management, message handling, heartbeat, broadcast
 *  - Tencent Cloud IM: login/auth via game_sign, event listeners, message sending
 *
 * Notes:
 *  - WebSocket is designed for multi-user (each WS connection has its own IM session).
 *  - HTTP API is "single-admin" style for quick testing/monitoring (as in developer docs).
 */

import TencentCloudChat from '@tencentcloud/chat';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { applyGame2Routes } from './game2_cunzhi/game2-api.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = process.env.API_BASE || 'https://suo.jiushu1234.com/api.php';
const STATE_FILE = process.env.STATE_FILE || path.resolve(process.cwd(), '..', 'state.json');
const WS_PATH = process.env.WS_PATH || '/ws'; // for nginx reverse proxy

// ---------- Helpers ----------
function nowIso() { return new Date().toISOString(); }
function genId(prefix='id') { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }

function log(level, ...args) {
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(`[${nowIso()}] [${level}] ${msg}`);
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function normalizeUid(input) {
  // 统一转为“不带 game_ 前缀”的纯 UID
  // - 输入 game_30033 => 30033
  // - 输入 30033      => 30033
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  return s.startsWith('game_') ? s.slice(5) : s;
}

function toGameUid(input) {
  const uid = normalizeUid(input);
  return uid ? `game_${uid}` : null;
}

function parseUidToken(uidInput, tokenInput) {
  const rawUid = String(uidInput ?? '').trim();
  const rawToken = String(tokenInput ?? '').trim();

  // 兼容用户直接粘贴 connect_code（格式："uid token"）
  const splitBySpace = (s) => s.split(/\s+/).map(v => v.trim()).filter(Boolean);

  let uid = rawUid;
  let token = rawToken;

  const tokenParts = splitBySpace(rawToken);
  if (tokenParts.length >= 2) {
    uid = tokenParts[0];
    token = tokenParts.slice(1).join(' ');
  }

  const uidParts = splitBySpace(rawUid);
  if (uidParts.length >= 2) {
    uid = uidParts[0];
    token = uidParts.slice(1).join(' ');
  }

  return {
    uid: normalizeUid(uid),
    token: String(token || '').trim(),
    usedConnectCode: tokenParts.length >= 2 || uidParts.length >= 2,
  };
}
function stripGamePrefix(id) {
  const s = String(id || '').trim();
  return s.startsWith('game_') ? s.slice(5) : s;
}

function findValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

async function readStateFile() {
  const raw = await fs.readFile(STATE_FILE, 'utf-8');
  const obj = JSON.parse(raw);
  if (!obj?.uid || !obj?.token) throw new Error('state.json 缺少 uid/token');
  return { uid: String(obj.uid), token: String(obj.token), signature: obj.signature ?? null };
}

async function requestGameSign(uid, token) {
  const url = `${API_BASE}/user/game_sign`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, token }),
  });
  if (!resp.ok) throw new Error(`game_sign http ${resp.status}`);
  const payload = await resp.json();
  if (payload?.code !== 1 || !payload?.data) {
    throw new Error(`game_sign 返回异常: ${JSON.stringify(payload)}`);
  }
  const data = payload.data;

  // tolerate multiple naming
  const appId = String(findValue(data, ['appid', 'appId', 'SDKAppID', 'sdkAppId']) ?? '');
  const userSig = String(findValue(data, ['sign', 'userSig', 'usersig']) ?? '');
  const userId = String(findValue(data, ['userid', 'userId', 'uid', 'userID']) ?? '');

  if (!appId || !userSig) throw new Error(`game_sign 缺少 appId/userSig: ${JSON.stringify(data)}`);

  return { appId: Number(appId), userSig, userId };
}

// ---------- IM Client (per session) ----------
class ChatClient {
  constructor({ loggerPrefix = 'im', onEvent = null } = {}) {
    this.chat = null;
    this.state = { uid: null, token: null, appId: null, userSig: null, userId: null };
    this.initialized = false;
    this.isReady = false;
    this.initPromise = null;
    this.sendQueue = Promise.resolve();
    this.destroyed = false;
    this.loggerPrefix = loggerPrefix;
    this.onEvent = onEvent;
  }

  _emit(evt, data) {
    if (typeof this.onEvent === 'function') {
      try { this.onEvent(evt, data); } catch (e) { /* ignore */ }
    }
  }

  async ensureReady(timeout = 15000) {
    if (this.destroyed) this.destroyed = false;
    if (this.isReady && this.initialized && this.chat) return;
    if (!this.initPromise) this.initPromise = this._initIM(timeout);
    await this.initPromise;
  }

  async loginWith(uid, token, timeout = 15000) {
    this.state.uid = normalizeUid(uid);
    this.state.token = String(token);
    if (!this.state.uid || !this.state.token) throw new Error('uid/token 不能为空');

    // if already logged in with same creds and ready, reuse
    if (this.initialized && this.isReady && this.chat) {
      if (this.state.uid === this._currentUid && this.state.token === this._currentToken) return;
    }

    // destroy any existing instance
    await this.destroy({ keepDestroyedFlag: true });

    this._currentUid = this.state.uid;
    this._currentToken = this.state.token;

    this.initPromise = this._initIM(timeout);
    await this.initPromise;
  }

  async _initIM(timeout = 15000) {
    const uid = normalizeUid(this.state.uid);
    const gameUid = toGameUid(uid);
    const token = this.state.token;

    this._emit('log', { level: 'info', msg: `正在获取 IM 签名: uid=${gameUid}` });
    const { appId, userSig } = await requestGameSign(gameUid, token);

    this.state.appId = appId;
    this.state.userSig = userSig;
    // 官方 IM 规范：登录 userID 必须使用 game_ 前缀账号
    // 发送目标 to 仍然使用纯 UID（不带 game_）
    this.state.userId = gameUid;

    // provide WebSocket implementation for Node
    // TencentCloudChat on Node expects global WebSocket
    if (typeof globalThis.WebSocket === 'undefined') {
      const wsmod = await import('ws');
      globalThis.WebSocket = wsmod.default;
    }

    this.chat = TencentCloudChat.create({ SDKAppID: appId });

    this._bindIMEvents();

    this._emit('log', { level: 'info', msg: `IM 登录中: appId=${appId}, userId=${this.state.userId}` });
    await this.chat.login({ userID: this.state.userId, userSig });

    await this._waitReady(timeout);

    this.initialized = true;
    this.isReady = true;
    this._emit('status', { isReady: true, config: { uid, userId: this.state.userId, appId } });
  }

  _bindIMEvents() {
    if (!this.chat) return;

    const ev = TencentCloudChat.EVENT;
    const TYPES = TencentCloudChat.TYPES;

    this.chat.on(ev.SDK_READY, () => {
      this.isReady = true;
      this._emit('imEvent', { type: 'SDK_READY' });
    });

    this.chat.on(ev.SDK_NOT_READY, () => {
      this.isReady = false;
      this._emit('imEvent', { type: 'SDK_NOT_READY' });
    });

    this.chat.on(ev.KICKED_OUT, (event) => {
      this.isReady = false;
      this._emit('imEvent', { type: 'KICKED_OUT', event });
    });

    this.chat.on(ev.NET_STATE_CHANGE, (event) => {
      this._emit('imEvent', { type: 'NET_STATE_CHANGE', event });
    });

    this.chat.on(ev.ERROR, (event) => {
      this._emit('imEvent', { type: 'ERROR', event });
    });

    this.chat.on(ev.MESSAGE_RECEIVED, (event) => {
      // 原始事件也保留（方便深度排查）
      this._emit('imEvent', { type: 'MESSAGE_RECEIVED', event });

      // ✅ 提取可读的入站消息（用于在网页端看到手机/App 回执）
      const list = event?.data || event?.data?.messageList || event?.messageList || event?.data?.message || [];
      const messageList = Array.isArray(list) ? list : (Array.isArray(list?.messageList) ? list.messageList : []);

      const simplified = messageList.map((m) => {
        const payloadText = m?.payload?.text;
        return {
          from: m?.from || m?.fromUser || m?.fromUserID || null,
          to: m?.to || m?.toUser || m?.toUserID || null,
          conversationID: m?.conversationID || null,
          type: m?.type || null,
          time: m?.time || null,
          // 只透传文本（若是 JSON 文本，前端可以自行解析）
          text: typeof payloadText === 'string' ? payloadText : null,
        };
      });

      if (simplified.length) {
        this._emit('incoming', { messages: simplified });
      }
    });
  }

  async _waitReady(timeout = 15000) {
    if (!this.chat) throw new Error('IM chat 未创建');
    if (this.isReady) return;

    await new Promise((resolve, reject) => {
      const ev = TencentCloudChat.EVENT;
      const onReady = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('等待 SDK_READY 超时'));
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
        try { this.chat?.off(ev.SDK_READY, onReady); } catch (e) { /* ignore */ }
      };

      try { this.chat?.on(ev.SDK_READY, onReady); } catch (e) { /* ignore */ }
    });
  }

  async sendToC2C(targetId, payloadObj) {
    // queue sends to avoid concurrent send causing odd states
    this.sendQueue = this.sendQueue.then(() => this._doSendToC2C(targetId, payloadObj)).catch((e) => {
      this._emit('log', { level: 'error', msg: `send queue error: ${e?.message || e}` });
    });
    return this.sendQueue;
  }

  async _doSendToC2C(targetId, payloadObj) {
    await this.ensureReady();

    if (!this.chat) throw new Error('IM 未初始化');
    if (!targetId) throw new Error('targetId 不能为空');

    const msg = this.chat.createTextMessage({
      // 官方示例里 to 常为纯数字（不带 game_ 前缀）
      to: normalizeUid(targetId),
      conversationType: TencentCloudChat.TYPES.CONV_C2C,
      payload: {
        // IMPORTANT: payload.text must be JSON string (developer doc)
        text: JSON.stringify(payloadObj),
      },
    });

    await this.chat.sendMessage(msg);
    this._emit('log', { level: 'success', msg: 'IM 消息发送成功' });
  }

  async destroy({ keepDestroyedFlag = false } = {}) {
    if (!this.chat) return;
    try {
      this._emit('log', { level: 'info', msg: '销毁 Chat 实例' });
      await this.chat.logout();
      await this.chat.destroy();
    } catch (e) {
      this._emit('log', { level: 'warn', msg: `销毁 Chat 实例出错: ${e?.message || e}` });
    } finally {
      this.chat = null;
      this.initialized = false;
      this.isReady = false;
      this.initPromise = null;
      this.sendQueue = Promise.resolve();
      this.destroyed = !keepDestroyedFlag ? true : false;
    }
  }
}

// ---------- Global "admin" client for HTTP API ----------
const adminClient = new ChatClient({
  loggerPrefix: 'admin',
  onEvent: (evt, data) => {
    if (evt === 'log') log(data.level?.toUpperCase() || 'INFO', `[ADMIN]`, data.msg);
    if (evt === 'status') log('INFO', `[ADMIN] status`, data);
  }
});
let adminConfig = { uid: null, token: null, appId: null, userId: null, isReady: false };

// ---------- Express HTTP ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const game2StaticCandidates = [
  path.resolve(process.cwd(), 'game2_cunzhi'),
  path.resolve(process.cwd(), 'game2_cunzhi', 'public', 'game2'),
];
const game2StaticDir = game2StaticCandidates.find((dir) => existsSync(path.join(dir, 'index.html'))) || game2StaticCandidates[0];

app.use('/game2', express.static(game2StaticDir));
app.get('/game2', (_req, res) => {
  res.sendFile(path.join(game2StaticDir, 'index.html'));
});
app.get('/yidimension-sdk.js', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'yidimension-sdk.js'));
});

await applyGame2Routes(app);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    wsClients: wss?.clients?.size ?? 0,
    admin: { isReady: adminConfig.isReady, uid: adminConfig.uid, userId: adminConfig.userId, appId: adminConfig.appId },
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    isReady: adminConfig.isReady,
    config: { uid: adminConfig.uid, userId: adminConfig.userId, appId: adminConfig.appId },
    wsClients: wss?.clients?.size ?? 0,
  });
});

app.post('/api/reinit', async (_req, res) => {
  try {
    const st = await readStateFile();
    const uid = normalizeUid(st.uid);
    const token = st.token;
    await adminClient.loginWith(uid, token);
    adminConfig = { ...adminConfig, uid, token, appId: adminClient.state.appId, userId: adminClient.state.userId, isReady: true };
    res.json({ success: true, message: 'IM 重新初始化成功', data: { uid, userId: adminConfig.userId, appId: adminConfig.appId } });
  } catch (e) {
    adminConfig.isReady = false;
    res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

app.post('/api/login', async (req, res) => {
  const { uid, token } = req.body || {};
  const parsed = parseUidToken(uid, token);
  if (!parsed.uid || !parsed.token) return res.status(400).json({ success: false, message: '缺少 uid/token（或 connect_code 解析失败）' });

  try {
    await adminClient.loginWith(parsed.uid, parsed.token);
    adminConfig = { ...adminConfig, uid: parsed.uid, token: parsed.token, appId: adminClient.state.appId, userId: adminClient.state.userId, isReady: true };
    res.json({ success: true, message: 'IM 登录成功', data: { uid: parsed.uid, userId: adminConfig.userId, appId: adminConfig.appId, usedConnectCode: parsed.usedConnectCode } });
  } catch (e) {
    adminConfig.isReady = false;
    res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

app.post('/api/send-command', async (req, res) => {
  const { commandId, payload, targetId } = req.body || {};
  const cmd = commandId || payload?.commandId || null;

  if (!adminConfig.isReady) return res.status(503).json({ success: false, message: 'IM 未就绪，请先登录或 reinit' });

  // Minimal compatibility: commandId -> payload object
  const finalPayload = payload || (cmd ? { code: cmd, data: 1, token: adminConfig.token } : null);
  if (!finalPayload) return res.status(400).json({ success: false, message: '缺少 commandId/payload' });

  try {
    // If no explicit targetId, default to self uid (common in demo)
    // ✅ 默认发送给当前登录的用户（玩家输入的 UID 归一化后），如显式传 targetId 则优先使用
    const to = normalizeUid(targetId || adminConfig.uid);
    await adminClient.sendToC2C(to, finalPayload);
    res.json({ success: true, message: '发送成功' });
  } catch (e) {
    adminConfig.isReady = false;
    res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

// ---------- HTTP server + WS ----------
const httpServer = createServer(app);
// 方案 B：不限制 WS_PATH，允许 ws://<ip>:3001 直连（不依赖 Nginx /ws 反代）
const wss = new WebSocketServer({ server: httpServer });

// per-WS session map (multi-user)
const sessions = new Map(); // ws -> { id, createdAt, isAlive, im: ChatClient, uid, token, isReady, lastActiveAt }

function wsSend(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (e) {
    // ignore
  }
}

function wsLog(ws, msg, level='info', extra=null) {
  wsSend(ws, { type: 'log', level, msg, time: nowIso(), ... (extra ? { extra } : {}) });
}

function wsStatus(ws, session) {
  wsSend(ws, { type: 'status', isOnline: true, isReady: !!session?.isReady, sessionId: session?.id, uid: session?.uid || null, time: nowIso() });
}

function broadcast(obj) {
  for (const client of wss.clients) {
    wsSend(client, obj);
  }
}

async function handleWsMessage(ws, session, msg) {
  const type = msg?.type;
  session.lastActiveAt = Date.now();

  switch (type) {
    case 'ping':
      wsSend(ws, { type: 'pong', time: nowIso() });
      break;

    case 'getStatus':
      wsStatus(ws, session);
      break;

    case 'login': {
      const parsed = parseUidToken(msg.uid, msg.token);
      const uid = parsed.uid;
      const token = parsed.token;
      if (!uid || !token) {
        wsLog(ws, '缺少 uid/token（或 connect_code 解析失败）', 'error');
        wsSend(ws, { type: 'loginResult', success: false, message: '缺少 uid/token（或 connect_code 解析失败）' });
        return;
      }

      session.uid = uid;
      session.token = String(token);

      wsLog(ws, `开始登录 IM: uid=${uid}`, 'info');
      try {
        await session.im.loginWith(uid, token);
        session.isReady = true;
        wsLog(ws, 'IM 登录成功', 'success', { uid, appId: session.im.state.appId, userId: session.im.state.userId });
        wsSend(ws, { type: 'loginResult', success: true, data: { uid, userId: session.im.state.userId, appId: session.im.state.appId, usedConnectCode: parsed.usedConnectCode } });
        wsStatus(ws, session);
      } catch (e) {
        session.isReady = false;
        wsLog(ws, `IM 登录失败: ${e?.message || e}`, 'error');
        wsSend(ws, { type: 'loginResult', success: false, message: e?.message || String(e) });
        wsStatus(ws, session);
      }
      break;
    }

    case 'logout': {
      wsLog(ws, '正在登出并销毁 IM 会话', 'info');
      try {
        await session.im.destroy();
      } finally {
        session.isReady = false;
        session.uid = null;
        session.token = null;
        wsSend(ws, { type: 'logoutResult', success: true });
        wsStatus(ws, session);
      }
      break;
    }

    case 'sendCommand': {
      if (!session.isReady) {
        wsLog(ws, 'IM 未就绪，请先 login', 'error');
        wsSend(ws, { type: 'sendResult', success: false, message: 'IM 未就绪' });
        return;
      }

      const payload = msg.payload;
      if (!payload) {
        wsLog(ws, 'payload 不能为空', 'error');
        wsSend(ws, { type: 'sendResult', success: false, message: 'payload 不能为空' });
        return;
      }

      // ✅ 发送对象策略：
      // 1) 前端显式传 msg.targetId 则优先
      // 2) 否则优先使用环境变量 GAME_CMD_TO（用于对齐官方“固定中枢账号”模式，例如 50141）
      // 3) 再否则发给当前登录用户（session.uid）
      // ✅ 发送对象策略（更贴近 TIM 真实收件人）：
      // 1) 前端显式传 msg.targetId 则优先（原样使用）
      // 2) 否则使用 GAME_CMD_TO（如你需要固定发送给某账号）
      // 3) 再否则默认发送给“当前 IM 登录的 userId”（game_sign 返回的 userId）
      // ✅ 收件人调试策略：同一条指令同时尝试发给多个可能的收件人（避免 userId 前缀差异导致“收到了但不执行”）
      // 1) 前端显式传 msg.targetId
      // 2) 环境变量 GAME_CMD_TO
      // 3) IM 实际登录 userId（game_sign 返回）
      // 4) session.uid（normalizeUid 后）
      // 5) 去掉 game_ 前缀的纯 uid
      // ✅ 收件人调试策略：候选全部统一为“纯 UID”（不带 game_）
      const candidatesRaw = [
        msg.targetId,
        process.env.GAME_CMD_TO,
        session.im?.state?.userId,
        session.uid,
      ];
      const targets = Array.from(
        new Set(candidatesRaw.filter(Boolean).map((v) => normalizeUid(v)).filter(Boolean))
      );
      const actualTo = targets[0] || "";

      // traceId 仅用于服务端日志追踪，不注入到 payload.text，避免对方严格校验失败
      const traceId = msg.traceId || genId('trace');

      // ✅ 严格按官方 game_cmd 结构（不额外塞 traceId）：{ code, id, token }
      let finalPayload;
      if (typeof payload === 'object' && payload !== null) {
        finalPayload = {
          code: String(payload.code || '').trim(),
          id: String(payload.id ?? '').trim(),
          token: String(payload.token || session.token || '').trim(),
        };
      } else {
        // 兼容：如果 payload 不是对象，则把它当作 commandId
        finalPayload = {
          code: 'game_cmd',
          id: String(payload).trim(),
          token: String(session.token || '').trim(),
        };
      }

      wsLog(ws, `发送指令 traceId=${traceId} -> ${actualTo}`, 'info', {
        finalPayload,
        note: { sessionUid: session.uid, imUserId: session.im?.state?.userId, targets }
      });

      try {
        // 逐个尝试发送（命中任意一个就认为成功），并把结果回传给前端
        const results = [];
        let okTo = null;
        for (const to of targets) {
          try {
            await session.im.sendToC2C(to, finalPayload);
            results.push({ to, ok: true });
            okTo = to;
            break;
          } catch (err) {
            results.push({ to, ok: false, message: err?.message || String(err) });
          }
        }

        if (okTo) {
          wsSend(ws, { type: 'sendResult', success: true, traceId, to: okTo, tried: results });
        } else {
          throw new Error(`所有候选收件人发送均失败: ${JSON.stringify(results)}`);
        }
      } catch (e) {
        session.isReady = false;
        wsLog(ws, `发送失败 traceId=${traceId}: ${e?.message || e}`, 'error');
        wsSend(ws, { type: 'sendResult', success: false, traceId, message: e?.message || String(e) });
        wsStatus(ws, session);
      }
      break;
    }

    case 'diagnose': {
      const connect = parseUidToken(msg.uid ?? session.uid, msg.token ?? session.token);
      const candidateTargets = [
        msg.targetId,
        process.env.GAME_CMD_TO,
        session.im?.state?.userId,
        connect.uid,
      ];
      const targets = Array.from(new Set(candidateTargets.filter(Boolean).map(v => normalizeUid(v)).filter(Boolean)));
      const commandId = String(msg.commandId || msg.id || '').trim();

      const checks = {
        wsConnected: true,
        imReady: !!session.isReady,
        uid: connect.uid,
        gameUid: toGameUid(connect.uid),
        tokenLength: connect.token ? connect.token.length : 0,
        tokenHasWhitespace: /\s/.test(connect.token || ''),
        commandId,
        commandIdLooksValid: /^[A-Za-z0-9_.-]+$/.test(commandId),
        targets,
      };

      try {
        if (connect.uid && connect.token) {
          const sign = await requestGameSign(toGameUid(connect.uid), connect.token);
          checks.gameSign = { ok: true, appId: sign.appId, userSigLength: (sign.userSig || '').length };
        } else {
          checks.gameSign = { ok: false, message: 'uid/token 缺失，无法验证签名接口' };
        }
      } catch (e) {
        checks.gameSign = { ok: false, message: e?.message || String(e) };
      }

      const hints = [];
      if (!checks.imReady) hints.push('IM 未就绪：先解决 KICKED_OUT/SDK_NOT_READY，再发指令');
      if (!checks.gameSign?.ok) hints.push('签名验证失败：connect_code 可能过期，需在 App 内重新启动游戏获取新的连接码');
      if (!checks.commandId) hints.push('commandId 为空：必须发送你在“开发游戏”里配置的指令 ID');
      if (checks.commandId && !checks.commandIdLooksValid) hints.push('commandId 含特殊空白/字符，建议与 App 配置的 ID 完全一致（大小写敏感）');
      if (targets.length === 0) hints.push('没有可用收件人 target，无法路由到 App');

      wsSend(ws, {
        type: 'diagnoseResult',
        success: true,
        time: nowIso(),
        checks,
        hints,
      });
      break;
    }

    default:
      wsLog(ws, `未知消息 type=${type}`, 'warn', { msg });
      wsSend(ws, { type: 'error', message: `未知消息 type=${type}` });
      break;
  }
}

// WS connection
wss.on('connection', (ws, req) => {
  const session = {
    id: genId('ws'),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    isAlive: true,
    uid: null,
    token: null,
    isReady: false,
    im: new ChatClient({
      loggerPrefix: 'ws',
      onEvent: (evt, data) => {
        // push im events to this client
        if (evt === 'log') wsLog(ws, data.msg, data.level || 'info');
        if (evt === 'status') {
          session.isReady = !!data.isReady;
          wsStatus(ws, session);
        }
        if (evt === 'imEvent') {
          wsSend(ws, { type: 'imEvent', ...data, time: nowIso() });
          // if kicked out, mark not ready
          if (data?.type === 'KICKED_OUT' || data?.type === 'SDK_NOT_READY') {
            session.isReady = false;
            wsStatus(ws, session);
          }
        }
        // ✅ 把入站消息（手机/App 的回执/响应）推送给网页端
        if (evt === 'incoming') {
          wsSend(ws, { type: 'incoming', time: nowIso(), ...data });
        }
      }
    })
  };

  sessions.set(ws, session);

  ws.on('pong', () => { session.isAlive = true; });
  ws.on('message', async (data) => {
    const text = data.toString();
    const msg = safeJsonParse(text);
    if (!msg) {
      wsLog(ws, '收到非 JSON 消息，已忽略', 'warn');
      return;
    }
    await handleWsMessage(ws, session, msg);
  });

  ws.on('close', async () => {
    sessions.delete(ws);
    try { await session.im.destroy(); } catch (e) { /* ignore */ }
  });

  ws.on('error', (err) => {
    log('WARN', `WS error session=${session.id}`, err?.message || err);
  });

  // welcome + status
  wsSend(ws, { type: 'welcome', sessionId: session.id, wsPath: WS_PATH, time: nowIso() });
  wsStatus(ws, session);
});

// Heartbeat: terminate dead clients
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    const session = sessions.get(ws);
    if (!session) continue;
    if (session.isAlive === false) {
      try { ws.terminate(); } catch (e) { /* ignore */ }
      sessions.delete(ws);
      continue;
    }
    session.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 30000);

// Safety: prevent process crash
process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason || '');
  const code = (reason && (reason.code ?? reason?.data?.code)) ?? undefined;
  if (code === 2801 || /请求超时/.test(msg)) return;
  log('ERROR', 'unhandledRejection', msg);
});
process.on('uncaughtException', (err) => {
  const msg = String(err?.message || err || '');
  const code = (err && (err.code ?? err?.data?.code)) ?? undefined;
  if (code === 2801 || /请求超时/.test(msg)) return;
  log('ERROR', 'uncaughtException', msg);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  log('INFO', '正在关闭服务...');
  clearInterval(heartbeatInterval);

  // close ws clients
  for (const ws of wss.clients) {
    try { ws.close(); } catch (e) { /* ignore */ }
  }

  // destroy admin
  try { await adminClient.destroy(); } catch (e) { /* ignore */ }

  httpServer.close(() => process.exit(0));
});

// Start
httpServer.listen(PORT, HOST, () => {
  log('INFO', `HTTP+WS server listening on http://${HOST}:${PORT} (ws path config: ${WS_PATH})`);
});

/*
================================================================================
【配套前端 SDK：/www/wwwroot/yidimension/yidimension-sdk.js】
说明：这是“日志增强 + 方案 B 直连 3001”的版本。
如果你当前 SDK 仍在连接 ws://106.14.83.149/ws，请把 yidimension-sdk.js 全量替换为下面这份。
================================================================================

(function (global) {
  const YiDimension = {
    socket: null,
    isConnected: false,
    isIMReady: false,

    onLog: null,
    onStatusChange: null,

    _retry: 0,
    _url: "",

    _emitLog(level, msg, extra) {
      try {
        const tail = extra ? " " + JSON.stringify(extra) : "";
        this.onLog && this.onLog(level, msg + tail);
      } catch (_) {}
    },

    _emitStatus() {
      try { this.onStatusChange && this.onStatusChange(this.isConnected, this.isIMReady); } catch (_) {}
    },

    _buildWsUrl() {
      // 允许临时强制指定：window.YIDIMENSION_WS_URL="ws://106.14.83.149:3001"
      if (global.YIDIMENSION_WS_URL) return String(global.YIDIMENSION_WS_URL);

      // ✅ 方案 B：直连 3001（不走 nginx /ws 反代）
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const host = location.hostname; // 只取域名/IP，不带端口
      return `${protocol}://${host}:3001`;
    },

    connect() {
      const url = this._buildWsUrl();
      this._url = url;

      this._emitLog("ws", `正在连接服务器: ${url}`, { retry: this._retry });

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this._emitLog("error", "WebSocket 构造失败", { url, message: e?.message || String(e) });
        return this._scheduleReconnect();
      }
      this.socket = ws;

      ws.onopen = () => {
        this.isConnected = true;
        this.isIMReady = false;
        this._retry = 0;
        this._emitLog("ws", "服务器连接成功", { url });
        this._emitStatus();
      };

      ws.onmessage = (event) => {
        let data = null;
        try { data = JSON.parse(event.data); } catch (_) {}

        if (!data) {
          this._emitLog("warn", "收到非 JSON 消息", { raw: String(event.data).slice(0, 200) });
          return;
        }

        if (data.type === "status") {
          this.isIMReady = !!(data.isReady ?? data.imReady ?? false);
          this._emitLog("info", "收到状态", data);
          this._emitStatus();
          return;
        }

        if (data.type === "log") {
          this._emitLog(data.level || "info", data.msg || "server log", data.extra || null);
          return;
        }

        this._emitLog("info", "收到消息", data);
      };

      ws.onerror = () => {
        this._emitLog("error", "WebSocket 发生错误", {
          url: this._url,
          readyState: ws.readyState
        });
      };

      ws.onclose = (evt) => {
        this.isConnected = false;
        this.isIMReady = false;
        this._emitStatus();

        this._emitLog("error", "服务器连接断开", {
          url: this._url,
          code: evt?.code,
          reason: evt?.reason,
          wasClean: evt?.wasClean,
          readyState: ws.readyState
        });

        this._scheduleReconnect();
      };
    },

    _scheduleReconnect() {
      this._retry += 1;
      this._emitLog("ws", "3秒后尝试重连...", { retry: this._retry, url: this._url });
      setTimeout(() => this.connect(), 3000);
    },

    login(uid, token) {
      if (!this.socket || this.socket.readyState !== 1) {
        this._emitLog("warn", "WS 未连接，无法 login（等重连成功后再点登录）");
        return;
      }
      this._emitLog("info", `开始登录（UID: ${uid}）`);
      this.socket.send(JSON.stringify({ type: "login", uid, token }));
    },

    send(value) {
      if (!this.socket || this.socket.readyState !== 1) {
        this._emitLog("warn", "WS 未连接，无法 send");
        return;
      }
      if (!this.isIMReady) {
        this._emitLog("warn", "IM 未就绪，无法 send");
        return;
      }

      // ✅ 按官方“游戏开发 / game_cmd”格式：payload.text 内必须是 JSON 字符串
      // 目标结构（由服务端补齐 token）：{ code: "game_cmd", id: "<commandId>", token: "<token>" }
      const commandId = String(value ?? "").trim();
      const payload = {
        code: "game_cmd",
        id: commandId
      };

      this._emitLog("info", "发送指令", payload);
      this.socket.send(JSON.stringify({ type: "sendCommand", payload }));
    },

    logout() {
      try {
        if (this.socket && this.socket.readyState === 1) {
          this.socket.send(JSON.stringify({ type: "logout" }));
        }
      } catch (_) {}
    }
  };

  global.YiDimension = YiDimension;
})(window);

================================================================================
*/
