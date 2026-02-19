import path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const config = {
  basePath: '/api/game2',
  schemaVersion: 1,
  gameVersion: '1.0.0',
  dbPath: path.resolve(process.cwd(), 'game2_cunzhi', 'data', 'game2.sqlite'),
  dataDir: path.resolve(process.cwd(), 'game2_cunzhi', 'data'),
  statuses: {
    active: 'active',
    paused: 'paused',
    interrupted: 'interrupted',
    complete: 'complete',
    aborted: 'aborted',
    completeWithWarning: 'complete_with_warning',
  },
  flow: {
    frequency: {
      levels: [1, 2, 3, 4, 5],
      adaptSeconds: 2,
      evaluateSeconds: 3,
      restSeconds: 20,
      scoreRange: [1, 5],
    },
    tolerance: {
      restSeconds: 20,
      minRounds: 4,
      maxRounds: 6,
      convergeRatio: 0.15,
      stableWindow: 3,
      guardRatio: 0.7,
    },
  },
  safety: {
    safetyTimeoutSec: 30,
  },
};

const TERMINAL_STATUS = new Set([
  config.statuses.complete,
  config.statuses.aborted,
  config.statuses.completeWithWarning,
]);

function nowTs() {
  return Date.now();
}

function makeDefaultState(uid, sessionId) {
  return {
    schemaVersion: config.schemaVersion,
    gameVersion: config.gameVersion,
    uid,
    sessionId,
    currentFlow: 'A',
    status: config.statuses.active,
    seqState: {
      maxSeq: 0,
      handled: {},
    },
    flowA: {
      levels: config.flow.frequency.levels.map((level) => ({
        level,
        adaptSeconds: config.flow.frequency.adaptSeconds,
        evaluateSeconds: config.flow.frequency.evaluateSeconds,
        restSeconds: config.flow.frequency.restSeconds,
        score: null,
      })),
      selectedFrequency: null,
    },
    flowB: {
      rounds: [],
      converged: false,
      T_stable: null,
      T_guard: null,
      warning: null,
    },
    safety: {
      safetyTimeoutSec: config.safety.safetyTimeoutSec,
      interruptedByVisibility: false,
      interruptedByApi: false,
    },
  };
}

function makeDefaultProfile(uid) {
  return {
    schemaVersion: config.schemaVersion,
    gameVersion: config.gameVersion,
    uid,
    latestSessionId: null,
    latestResult: null,
  };
}

function normalizeState(obj, uid, sessionId) {
  const base = makeDefaultState(uid, sessionId);
  const next = { ...base, ...(obj || {}) };
  next.schemaVersion = config.schemaVersion;
  next.gameVersion = config.gameVersion;
  next.uid = uid || next.uid;
  next.sessionId = sessionId || next.sessionId;
  next.seqState = {
    maxSeq: Number(next.seqState?.maxSeq || 0),
    handled: { ...(next.seqState?.handled || {}) },
  };
  next.flowA = {
    ...base.flowA,
    ...(next.flowA || {}),
    levels: Array.isArray(next.flowA?.levels) && next.flowA.levels.length
      ? next.flowA.levels.map((row) => ({
          level: Number(row.level),
          adaptSeconds: Number(row.adaptSeconds ?? config.flow.frequency.adaptSeconds),
          evaluateSeconds: Number(row.evaluateSeconds ?? config.flow.frequency.evaluateSeconds),
          restSeconds: Number(row.restSeconds ?? config.flow.frequency.restSeconds),
          score: row.score == null ? null : Number(row.score),
        }))
      : base.flowA.levels,
  };
  next.flowB = {
    ...base.flowB,
    ...(next.flowB || {}),
    rounds: Array.isArray(next.flowB?.rounds)
      ? next.flowB.rounds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [],
  };
  next.safety = { ...base.safety, ...(next.safety || {}) };
  return next;
}

function normalizeProfile(obj, uid) {
  const base = makeDefaultProfile(uid);
  const next = { ...base, ...(obj || {}) };
  next.schemaVersion = config.schemaVersion;
  next.gameVersion = config.gameVersion;
  next.uid = uid || next.uid;
  return next;
}

function median(nums) {
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (!arr.length) return null;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function evalConvergence(rounds) {
  if (rounds.length < config.flow.tolerance.stableWindow) {
    return { converged: false, T_stable: null, T_guard: null };
  }
  const recent = rounds.slice(-config.flow.tolerance.stableWindow);
  const med = median(recent);
  const max = Math.max(...recent);
  const min = Math.min(...recent);
  const converged = (max - min) <= config.flow.tolerance.convergeRatio * med;
  return {
    converged,
    T_stable: med,
    T_guard: Number((config.flow.tolerance.guardRatio * med).toFixed(4)),
  };
}

function quote(v) {
  if (v == null) return 'NULL';
  const s = String(v).replace(/'/g, "''");
  return `'${s}'`;
}

async function runSql(dbPath, sql) {
  await execFileAsync('sqlite3', [dbPath, sql]);
}

async function getSql(dbPath, sql) {
  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql]);
  const arr = JSON.parse(stdout || '[]');
  return arr[0] || null;
}

async function allSql(dbPath, sql) {
  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql]);
  return JSON.parse(stdout || '[]');
}

async function initDb() {
  await fs.mkdir(config.dataDir, { recursive: true });
  const ddl = `
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  uid TEXT,
  game TEXT,
  status TEXT,
  state_json TEXT,
  schema_version INTEGER,
  game_version TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  uid TEXT,
  type TEXT,
  payload_json TEXT,
  ts INTEGER
);
CREATE TABLE IF NOT EXISTS profiles(
  uid TEXT PRIMARY KEY,
  profile_json TEXT,
  schema_version INTEGER,
  game_version TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
`;
  await runSql(config.dbPath, ddl);
}

async function getSessionById(sessionId) {
  return getSql(config.dbPath, `SELECT * FROM sessions WHERE id=${quote(sessionId)} LIMIT 1;`);
}

async function getActiveSession(uid) {
  return getSql(
    config.dbPath,
    `SELECT * FROM sessions WHERE uid=${quote(uid)} AND status NOT IN ('complete','aborted','complete_with_warning') ORDER BY updated_at DESC LIMIT 1;`,
  );
}

async function persistSession(record) {
  const sql = `
INSERT INTO sessions(id, uid, game, status, state_json, schema_version, game_version, created_at, updated_at)
VALUES(${quote(record.id)}, ${quote(record.uid)}, ${quote(record.game)}, ${quote(record.status)}, ${quote(record.state_json)}, ${record.schema_version}, ${quote(record.game_version)}, ${record.created_at}, ${record.updated_at})
ON CONFLICT(id) DO UPDATE SET
  uid=excluded.uid,
  game=excluded.game,
  status=excluded.status,
  state_json=excluded.state_json,
  schema_version=excluded.schema_version,
  game_version=excluded.game_version,
  updated_at=excluded.updated_at;
`;
  await runSql(config.dbPath, sql);
}

async function appendEvent({ sessionId, uid, type, payload }) {
  const sql = `INSERT INTO events(session_id, uid, type, payload_json, ts)
VALUES(${quote(sessionId)}, ${quote(uid)}, ${quote(type)}, ${quote(JSON.stringify(payload || {}))}, ${nowTs()});`;
  await runSql(config.dbPath, sql);
}

async function getProfile(uid) {
  return getSql(config.dbPath, `SELECT * FROM profiles WHERE uid=${quote(uid)} LIMIT 1;`);
}

async function persistProfile(uid, profile) {
  const ts = nowTs();
  const sql = `
INSERT INTO profiles(uid, profile_json, schema_version, game_version, updated_at)
VALUES(${quote(uid)}, ${quote(JSON.stringify(profile))}, ${config.schemaVersion}, ${quote(config.gameVersion)}, ${ts})
ON CONFLICT(uid) DO UPDATE SET
  profile_json=excluded.profile_json,
  schema_version=excluded.schema_version,
  game_version=excluded.game_version,
  updated_at=excluded.updated_at;
`;
  await runSql(config.dbPath, sql);
}

function ensureUidSession(body = {}) {
  const uid = String(body.uid || '').trim();
  const sessionId = String(body.sessionId || '').trim();
  if (!uid || !sessionId) return { ok: false, msg: 'uid 和 sessionId 必填' };
  return { ok: true, uid, sessionId };
}

function isDupByIdempotency(state, type, seq) {
  const key = `${type}:${seq}`;
  return !!state.seqState.handled[key];
}

function markIdempotent(state, type, seq) {
  const key = `${type}:${seq}`;
  state.seqState.handled[key] = true;
  state.seqState.maxSeq = Math.max(state.seqState.maxSeq, seq);
}

export async function applyGame2Routes(app) {
  await initDb();

  app.get(`${config.basePath}/session/active`, async (req, res) => {
    const uid = String(req.query.uid || '').trim();
    if (!uid) return res.status(400).json({ ok: false, message: '缺少 uid' });

    const active = await getActiveSession(uid);
    if (!active) return res.json({ ok: true, session: null });

    const state = normalizeState(JSON.parse(active.state_json || '{}'), uid, active.id);
    await persistSession({ ...active, state_json: JSON.stringify(state), status: state.status, updated_at: nowTs() });

    res.json({ ok: true, session: { ...active, state_json: state } });
  });

  app.post(`${config.basePath}/session/start`, async (req, res) => {
    const { uid, sessionId } = req.body || {};
    const seq = Number(req.body?.seq || 0);
    if (!uid || !sessionId) return res.status(400).json({ ok: false, message: 'uid/sessionId 必填' });

    const active = await getActiveSession(uid);
    if (active && active.id !== sessionId) {
      return res.status(409).json({ ok: false, conflict: true, activeSessionId: active.id, message: '已有未完成会话' });
    }

    const existed = await getSessionById(sessionId);
    if (existed) {
      const state = normalizeState(JSON.parse(existed.state_json || '{}'), uid, sessionId);
      if (seq && isDupByIdempotency(state, 'start', seq)) {
        return res.json({ ok: true, idempotent: true, sessionId });
      }
      if (seq && seq < state.seqState.maxSeq) {
        return res.json({ ok: true, dropped: true, reason: 'seq_too_old', maxSeq: state.seqState.maxSeq });
      }
      if (seq) markIdempotent(state, 'start', seq);
      state.status = config.statuses.active;
      await persistSession({ ...existed, status: config.statuses.active, state_json: JSON.stringify(state), updated_at: nowTs() });
      await appendEvent({ sessionId, uid, type: 'start', payload: req.body });
      return res.json({ ok: true, resumed: true, sessionId, state });
    }

    const ts = nowTs();
    const state = makeDefaultState(uid, sessionId);
    if (seq) markIdempotent(state, 'start', seq);
    const sessionRow = {
      id: sessionId,
      uid,
      game: 'game2',
      status: config.statuses.active,
      state_json: JSON.stringify(state),
      schema_version: config.schemaVersion,
      game_version: config.gameVersion,
      created_at: ts,
      updated_at: ts,
    };
    await persistSession(sessionRow);
    await appendEvent({ sessionId, uid, type: 'start', payload: req.body });
    res.json({ ok: true, created: true, sessionId, state });
  });

  app.post(`${config.basePath}/session/progress`, async (req, res) => {
    const checked = ensureUidSession(req.body);
    if (!checked.ok) return res.status(400).json({ ok: false, message: checked.msg });

    const { uid, sessionId } = checked;
    const seq = Number(req.body?.seq || 0);
    const row = await getSessionById(sessionId);
    if (!row || row.uid !== uid) return res.status(404).json({ ok: false, message: '会话不存在或 uid 不匹配' });

    const state = normalizeState(JSON.parse(row.state_json || '{}'), uid, sessionId);
    if (seq && seq < state.seqState.maxSeq) {
      return res.json({ ok: true, dropped: true, reason: 'seq_too_old', maxSeq: state.seqState.maxSeq });
    }
    const action = String(req.body?.action || '').trim();
    if (seq && isDupByIdempotency(state, `progress:${action}`, seq)) {
      return res.json({ ok: true, idempotent: true, sessionId, state });
    }

    if (action === 'frequency_score') {
      const level = Number(req.body?.level);
      const score = Number(req.body?.score);
      if (!config.flow.frequency.levels.includes(level)) {
        return res.status(400).json({ ok: false, message: 'level 必须在 1..5' });
      }
      if (score < config.flow.frequency.scoreRange[0] || score > config.flow.frequency.scoreRange[1]) {
        return res.status(400).json({ ok: false, message: 'score 必须在 1..5' });
      }
      const item = state.flowA.levels.find((x) => x.level === level);
      if (item) item.score = score;
    } else if (action === 'frequency_select') {
      const selected = Number(req.body?.selectedFrequency);
      if (!config.flow.frequency.levels.includes(selected)) {
        return res.status(400).json({ ok: false, message: 'selectedFrequency 必须在 1..5' });
      }
      state.flowA.selectedFrequency = selected;
      state.currentFlow = 'B';
    } else if (action === 'tolerance_stop') {
      const elapsedSec = Number(req.body?.elapsedSec);
      if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) {
        return res.status(400).json({ ok: false, message: 'elapsedSec 必须是正数' });
      }
      state.flowB.rounds.push(elapsedSec);
      const stats = evalConvergence(state.flowB.rounds);
      state.flowB.converged = stats.converged;
      state.flowB.T_stable = stats.T_stable;
      state.flowB.T_guard = stats.T_guard;
      const rounds = state.flowB.rounds.length;
      if (rounds >= config.flow.tolerance.minRounds && stats.converged) {
        state.status = config.statuses.complete;
      } else if (rounds >= config.flow.tolerance.maxRounds && !stats.converged) {
        state.status = config.statuses.completeWithWarning;
        state.flowB.warning = '轮次达到上限仍未收敛';
      }
    } else if (action === 'interrupted') {
      state.status = config.statuses.interrupted;
      state.safety.interruptedByVisibility = !!req.body?.byVisibility;
      state.safety.interruptedByApi = !!req.body?.byApi;
    } else {
      return res.status(400).json({ ok: false, message: '未知 action' });
    }

    if (seq) markIdempotent(state, `progress:${action}`, seq);

    await persistSession({ ...row, status: state.status, state_json: JSON.stringify(state), updated_at: nowTs() });
    await appendEvent({ sessionId, uid, type: action, payload: req.body });
    res.json({ ok: true, sessionId, status: state.status, state });
  });

  app.post(`${config.basePath}/event`, async (req, res) => {
    const checked = ensureUidSession(req.body);
    if (!checked.ok) return res.status(400).json({ ok: false, message: checked.msg });
    const { uid, sessionId } = checked;
    const row = await getSessionById(sessionId);
    if (!row || row.uid !== uid) return res.status(404).json({ ok: false, message: '会话不存在或 uid 不匹配' });
    const eventType = String(req.body?.type || 'custom').trim();
    await appendEvent({ sessionId, uid, type: eventType, payload: req.body?.payload || {} });
    res.json({ ok: true });
  });

  app.post(`${config.basePath}/session/complete`, async (req, res) => {
    const checked = ensureUidSession(req.body);
    if (!checked.ok) return res.status(400).json({ ok: false, message: checked.msg });
    const { uid, sessionId } = checked;
    const seq = Number(req.body?.seq || 0);

    const row = await getSessionById(sessionId);
    if (!row || row.uid !== uid) return res.status(404).json({ ok: false, message: '会话不存在或 uid 不匹配' });

    const state = normalizeState(JSON.parse(row.state_json || '{}'), uid, sessionId);
    if (seq && seq < state.seqState.maxSeq) {
      return res.json({ ok: true, dropped: true, reason: 'seq_too_old', maxSeq: state.seqState.maxSeq });
    }
    if (seq && isDupByIdempotency(state, 'complete', seq)) {
      return res.json({ ok: true, idempotent: true, sessionId, status: state.status });
    }
    if (seq) markIdempotent(state, 'complete', seq);

    if (!TERMINAL_STATUS.has(state.status)) {
      state.status = req.body?.status === config.statuses.completeWithWarning
        ? config.statuses.completeWithWarning
        : config.statuses.complete;
    }

    await persistSession({ ...row, status: state.status, state_json: JSON.stringify(state), updated_at: nowTs() });
    await appendEvent({ sessionId, uid, type: 'complete', payload: req.body });

    const currentProfileRow = await getProfile(uid);
    const profile = normalizeProfile(currentProfileRow ? JSON.parse(currentProfileRow.profile_json || '{}') : null, uid);
    profile.latestSessionId = sessionId;
    profile.latestResult = {
      status: state.status,
      flowA: state.flowA,
      flowB: state.flowB,
      completedAt: nowTs(),
    };
    await persistProfile(uid, profile);

    // stop/complete 需要快速 ACK
    res.json({ ok: true, ack: true, status: state.status, flowB: state.flowB });
  });

  app.post(`${config.basePath}/user/reset`, async (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const mode = String(req.body?.mode || 'soft').trim();
    if (!uid) return res.status(400).json({ ok: false, message: 'uid 必填' });

    const active = await getActiveSession(uid);
    if (mode === 'hard') {
      await runSql(config.dbPath, `DELETE FROM events WHERE uid=${quote(uid)};DELETE FROM sessions WHERE uid=${quote(uid)};DELETE FROM profiles WHERE uid=${quote(uid)};`);
      return res.json({ ok: true, mode, removedAll: true });
    }

    if (active) {
      const state = normalizeState(JSON.parse(active.state_json || '{}'), uid, active.id);
      state.status = config.statuses.aborted;
      await persistSession({ ...active, status: config.statuses.aborted, state_json: JSON.stringify(state), updated_at: nowTs() });
      await appendEvent({ sessionId: active.id, uid, type: 'soft_reset', payload: req.body });
    }

    const row = await getProfile(uid);
    const profile = normalizeProfile(row ? JSON.parse(row.profile_json || '{}') : null, uid);
    profile.latestResult = null;
    await persistProfile(uid, profile);

    res.json({ ok: true, mode, abortedSessionId: active?.id || null });
  });

  app.get(`${config.basePath}/debug/events`, async (req, res) => {
    const sessionId = String(req.query.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ ok: false, message: '缺少 sessionId' });
    const rows = await allSql(config.dbPath, `SELECT * FROM events WHERE session_id=${quote(sessionId)} ORDER BY id ASC;`);
    res.json({ ok: true, events: rows.map((r) => ({ ...r, payload_json: JSON.parse(r.payload_json || '{}') })) });
  });
}
