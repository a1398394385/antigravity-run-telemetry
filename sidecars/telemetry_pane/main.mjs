/**
 * Run Telemetry Sidecar Backend
 * 复用 lib/telemetry.mjs 解析单会话每轮 Agent RUN 与跨会话每日汇总数据。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { buildSessionDailyBuckets, formatModelDisplayName, parseRuns, readJsonl, toLocalDateKey } from '../../lib/telemetry.mjs';
import { getContextReport, getTaskLog, refreshCatalog } from './context_service.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 会话级增量缓存：key = logsDir -> { transcriptMtime, transcriptSize, timingMtime, timingSize, buckets }
const dailySessionCache = new Map();
// ListConversations 短期缓存：key = parentConvId -> { ts, items }
const childRpcCache = new Map();

function findAppDataDirs() {
  const dirs = [];
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      if (existsSync(join(appData, 'brain'))) {
        dirs.push(appData);
      }
      break;
    }
  }
  const home = homedir();
  for (const name of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const p = join(home, '.gemini', name);
    if (!dirs.includes(p) && existsSync(join(p, 'brain'))) {
      dirs.push(p);
    }
  }
  return dirs;
}

function resolveLogsDir(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appData of findAppDataDirs()) {
    const logsDir = join(appData, 'brain', convId, '.system_generated', 'logs');
    if (existsSync(logsDir)) return logsDir;
  }
  return null;
}

function resolveConvRootDir(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appData of findAppDataDirs()) {
    const dir = join(appData, 'brain', convId);
    if (existsSync(dir)) return dir;
  }
  return null;
}

function readSingleConversationTelemetry(convId) {
  const logsDir = resolveLogsDir(convId);
  if (!logsDir) return null;

  const fullPath = join(logsDir, 'transcript_full.jsonl');
  const compactPath = join(logsDir, 'transcript.jsonl');
  const transcriptPath = existsSync(fullPath) ? fullPath : compactPath;
  const timingPath = join(logsDir, 'run_telemetry.jsonl');

  const transcriptRows = readJsonl(transcriptPath);
  const timingEvents = readJsonl(timingPath);

  let mtimeMs = 0;
  try { mtimeMs = Math.max(mtimeMs, statSync(transcriptPath).mtimeMs); } catch {}
  try { mtimeMs = Math.max(mtimeMs, statSync(timingPath).mtimeMs); } catch {}

  const parsed = parseRuns(transcriptRows, timingEvents);
  return { logsDir, transcriptRows, mtimeMs, parsed };
}

function extractSwarmMembers(convId) {
  const convDir = resolveConvRootDir(convId);
  if (!convDir) return [];
  const membersPath = join(convDir, '.system_generated', 'swarm', 'members.json');
  if (!existsSync(membersPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(membersPath, 'utf-8'));
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.members)
        ? raw.members
        : raw && typeof raw === 'object'
          ? Object.entries(raw).map(([name, val]) => ({ name, ...(typeof val === 'object' ? val : {}) }))
          : [];
    const out = [];
    for (const m of list) {
      const cid = m?.conversationId || m?.conversation_id || m?.id;
      if (cid && ID_RE.test(cid) && cid !== convId) {
        const label = m.name || m.role || 'worker';
        out.push({ conversationId: cid, kind: 'swarm', label: String(label) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function unquoteArg(val) {
  if (typeof val !== 'string') return '';
  const s = val.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === 'string' ? parsed.trim() : s;
    } catch {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function extractSubagentsFromTranscript(convId, transcriptRows) {
  const pendingInvocations = [];
  let lastLabel = '';
  const found = [];
  const seen = new Set();

  for (const row of transcriptRows) {
    if (Array.isArray(row.tool_calls)) {
      for (const tc of row.tool_calls) {
        if (tc?.name === 'invoke_subagent') {
          const args = tc.args || {};
          const role = unquoteArg(args.Role || args.role);
          const typeName = unquoteArg(args.TypeName || args.type_name);
          const label = role || typeName || '';
          pendingInvocations.push(label);
          if (label) lastLabel = label;
        }
      }
    }
    if (typeof row.content === 'string' && (row.content.includes('conversationId') || row.content.includes('conversation_id'))) {
      const matches = row.content.matchAll(/["']?(?:conversationId|conversation_id)["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f-]{12,})["']?/gi);
      for (const m of matches) {
        const cid = m[1];
        if (!cid || cid === convId || seen.has(cid)) continue;
        seen.add(cid);
        const queued = pendingInvocations.length > 0 ? pendingInvocations.shift() : '';
        const label = queued || lastLabel || 'subagent';
        found.push({ conversationId: cid, kind: 'subagent', label });
      }
    }
  }
  return found;
}

async function fetchChildConversationsViaRpc(convId) {
  const cached = childRpcCache.get(convId);
  if (cached && Date.now() - cached.ts < 5000) return cached.items;

  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const res = await fetch(`http://${lsAddr}/product.v1.ConversationService/ListConversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-antigravity-csrf-token': csrf,
      },
      body: JSON.stringify({ parentConversationId: convId, pageSize: 100, includeArchived: true }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = await res.json();
    const items = Array.isArray(json?.conversations)
      ? json.conversations
          .filter((c) => c?.id && ID_RE.test(c.id) && c.id !== convId)
          .map((c) => ({
            conversationId: c.id,
            kind: 'child',
            label: c.annotations?.title || c.state?.summary || 'subagent',
          }))
      : [];
    childRpcCache.set(convId, { ts: Date.now(), items });
    return items;
  } catch {
    return [];
  }
}

function summarizeRunsList(runs) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let timedSteps = 0;
  let timedMs = 0;
  let timedOutputTokens = 0;
  let costUsd = 0;
  let hasPricedStep = false;
  let stepCount = 0;
  let isRunning = false;

  for (const r of runs) {
    stepCount += r.stepCount || 0;
    inputTokens += r.inputTokens || 0;
    outputTokens += r.outputTokens || 0;
    cacheReadTokens += r.cacheReadTokens || 0;
    if (r.costUsd !== null && r.costUsd !== undefined) {
      costUsd += r.costUsd;
      hasPricedStep = true;
    }
    if (r.isRunning) isRunning = true;
    for (const s of (r.steps || [])) {
      if (s.latencyMs !== null && s.latencyMs > 0) {
        timedSteps += 1;
        timedMs += s.latencyMs;
        timedOutputTokens += s.outputTokens || 0;
      }
    }
  }

  const totalTokens = inputTokens + outputTokens + cacheReadTokens;
  const cacheDenom = inputTokens + cacheReadTokens;
  return {
    stepCount,
    timedSteps,
    avgLatencyMs: timedSteps > 0 ? Math.round(timedMs / timedSteps) : null,
    effectiveTps: timedMs > 0 ? Number(((timedOutputTokens / timedMs) * 1000).toFixed(1)) : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    cacheHitRate: cacheDenom > 0 ? Number(((cacheReadTokens / cacheDenom) * 100).toFixed(1)) : 0,
    costUsd: hasPricedStep ? costUsd : null,
    isRunning,
  };
}

function listAllConversationLogsDirs() {
  const seen = new Set();
  const result = [];
  for (const appData of findAppDataDirs()) {
    const brainDir = join(appData, 'brain');
    let entries;
    try {
      entries = readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !ID_RE.test(ent.name) || seen.has(ent.name)) continue;
      const logsDir = join(brainDir, ent.name, '.system_generated', 'logs');
      if (existsSync(logsDir)) {
        seen.add(ent.name);
        result.push({ convId: ent.name, logsDir });
      }
    }
  }
  return result;
}

function getFileStamp(path) {
  if (!existsSync(path)) return { mtimeMs: 0, size: 0, exists: false };
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size, exists: true };
  } catch {
    return { mtimeMs: 0, size: 0, exists: false };
  }
}

function getSessionDailyBuckets(logsDir) {
  const fullPath = join(logsDir, 'transcript_full.jsonl');
  const compactPath = join(logsDir, 'transcript.jsonl');
  const transcriptPath = existsSync(fullPath) ? fullPath : compactPath;
  const timingPath = join(logsDir, 'run_telemetry.jsonl');

  const trStamp = getFileStamp(transcriptPath);
  if (!trStamp.exists) return null;
  const tmStamp = getFileStamp(timingPath);

  const cached = dailySessionCache.get(logsDir);
  if (
    cached &&
    cached.transcriptPath === transcriptPath &&
    cached.trMtime === trStamp.mtimeMs &&
    cached.trSize === trStamp.size &&
    cached.tmMtime === tmStamp.mtimeMs &&
    cached.tmSize === tmStamp.size
  ) {
    return cached.buckets;
  }

  const buckets = buildSessionDailyBuckets(readJsonl(transcriptPath), readJsonl(timingPath));
  dailySessionCache.set(logsDir, {
    transcriptPath,
    trMtime: trStamp.mtimeMs,
    trSize: trStamp.size,
    tmMtime: tmStamp.mtimeMs,
    tmSize: tmStamp.size,
    buckets,
  });
  return buckets;
}

function finalizeMetrics(acc, sessionCount) {
  const totalTokens = acc.inputTokens + acc.outputTokens + acc.cacheReadTokens;
  const cacheDenom = acc.inputTokens + acc.cacheReadTokens;
  const cacheHitRate = cacheDenom > 0
    ? Number(((acc.cacheReadTokens / cacheDenom) * 100).toFixed(1))
    : 0;
  const avgLatencyMs = acc.timedSteps > 0 ? Math.round(acc.timedMs / acc.timedSteps) : null;
  const effectiveTps = acc.timedMs > 0
    ? Number(((acc.timedOutputTokens / acc.timedMs) * 1000).toFixed(1))
    : null;
  return {
    sessionCount,
    stepCount: acc.stepCount,
    timedSteps: acc.timedSteps,
    avgLatencyMs,
    effectiveTps,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    totalTokens,
    cacheHitRate,
    costUsd: acc.hasPricedStep ? acc.costUsd : null,
  };
}

function computeDailySummary(targetDate) {
  const allDirs = listAllConversationLogsDirs();
  const availableDatesSet = new Set();

  const totalAcc = {
    stepCount: 0,
    timedSteps: 0,
    timedMs: 0,
    timedOutputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    hasPricedStep: false,
  };
  const sessionIdsForDate = new Set();
  const modelMap = new Map(); // model -> { acc, sessionIds: Set }

  for (const { convId, logsDir } of allDirs) {
    const buckets = getSessionDailyBuckets(logsDir);
    if (!buckets) continue;

    for (const d of Object.keys(buckets)) {
      availableDatesSet.add(d);
    }

    const dayModels = buckets[targetDate];
    if (!dayModels) continue;

    sessionIdsForDate.add(convId);
    for (const [model, m] of Object.entries(dayModels)) {
      totalAcc.stepCount += m.stepCount;
      totalAcc.timedSteps += m.timedSteps;
      totalAcc.timedMs += m.timedMs;
      totalAcc.timedOutputTokens += m.timedOutputTokens;
      totalAcc.inputTokens += m.inputTokens;
      totalAcc.outputTokens += m.outputTokens;
      totalAcc.cacheReadTokens += m.cacheReadTokens;
      if (m.hasPricedStep) {
        totalAcc.costUsd += m.costUsd;
        totalAcc.hasPricedStep = true;
      }

      if (!modelMap.has(model)) {
        modelMap.set(model, {
          acc: {
            stepCount: 0,
            timedSteps: 0,
            timedMs: 0,
            timedOutputTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0,
            hasPricedStep: false,
          },
          sessionIds: new Set(),
          thinkingLevels: new Set(),
        });
      }
      const entry = modelMap.get(model);
      entry.sessionIds.add(convId);
      for (const lv of (m.thinkingLevels || [])) entry.thinkingLevels.add(lv);
      entry.acc.stepCount += m.stepCount;
      entry.acc.timedSteps += m.timedSteps;
      entry.acc.timedMs += m.timedMs;
      entry.acc.timedOutputTokens += m.timedOutputTokens;
      entry.acc.inputTokens += m.inputTokens;
      entry.acc.outputTokens += m.outputTokens;
      entry.acc.cacheReadTokens += m.cacheReadTokens;
      if (m.hasPricedStep) {
        entry.acc.costUsd += m.costUsd;
        entry.acc.hasPricedStep = true;
      }
    }
  }

  const models = Array.from(modelMap.entries())
    .map(([model, { acc, sessionIds, thinkingLevels }]) => ({
      model,
      displayName: formatModelDisplayName(model),
      thinkingLevels: Array.from(thinkingLevels),
      ...finalizeMetrics(acc, sessionIds.size),
    }))
    .sort((a, b) => {
      const costDiff = (b.costUsd ?? -1) - (a.costUsd ?? -1);
      if (costDiff !== 0) return costDiff;
      return b.totalTokens - a.totalTokens;
    });

  const availableDates = Array.from(availableDatesSet).sort().reverse();
  return {
    date: targetDate,
    availableDates,
    summary: finalizeMetrics(totalAcc, sessionIdsForDate.size),
    models,
  };
}

function detectSystemLang() {
  let raw = '';
  try {
    if (process.platform === 'darwin') {
      const langs = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 1000 });
      const m = langs.match(/"([^"]+)"/) || langs.match(/^\s*([a-zA-Z0-9_-]+)/m);
      raw = m ? m[1] : '';
      if (!raw) {
        raw = execFileSync('defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', timeout: 1000 }).trim();
      }
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKCU\\Control Panel\\International', '/v', 'LocaleName'], { encoding: 'utf8', timeout: 1000 });
      const m = out.match(/LocaleName\s+REG_SZ\s+(\S+)/i);
      raw = m ? m[1] : '';
    }
  } catch {
    // 忽略读取系统语言异常，回退环境变量
  }
  if (!raw) {
    const envLang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
    if (envLang && !/^(C|POSIX)(\.|$)/i.test(envLang)) raw = envLang;
  }
  if (!raw) {
    raw = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  }
  return /^zh\b/i.test(raw) ? 'zh' : 'en';
}

const SYSTEM_LANG = detectSystemLang();

function serveHtml(filename) {
  const html = readFileSync(join(__dirname, filename), 'utf-8')
    .replace('<head>', `<head><script>window.__RT_SYSTEM_LANG__=${JSON.stringify(SYSTEM_LANG)};</script>`);
  return new Response(html, {
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  });
}

const app = new SidecarApp();

app.page('/', () => serveHtml('index.html'));

app.api('/api/telemetry', async (data) => {
  const convId = data.conversationId || app.config.conversationId || '';
  if (!convId || !ID_RE.test(convId)) {
    return { conversationId: convId || null, found: false, runs: [], children: [] };
  }

  const mainData = readSingleConversationTelemetry(convId);
  if (!mainData) {
    return { conversationId: convId, found: false, runs: [], children: [] };
  }

  // 发现关联的 Swarm / Subagent 子会话（本地文件 + RPC 兜底）
  const childMap = new Map();
  for (const item of extractSwarmMembers(convId)) {
    childMap.set(item.conversationId, item);
  }
  for (const item of extractSubagentsFromTranscript(convId, mainData.transcriptRows)) {
    if (!childMap.has(item.conversationId)) childMap.set(item.conversationId, item);
  }
  for (const item of await fetchChildConversationsViaRpc(convId)) {
    const existing = childMap.get(item.conversationId);
    if (!existing) {
      childMap.set(item.conversationId, item);
    } else if ((!existing.label || existing.label === 'subagent') && item.label && item.label !== 'subagent') {
      existing.label = item.label;
    }
  }

  let maxMtime = mainData.mtimeMs;
  const children = [];
  for (const meta of childMap.values()) {
    const childData = readSingleConversationTelemetry(meta.conversationId);
    if (!childData || childData.parsed.runs.length === 0) continue;
    maxMtime = Math.max(maxMtime, childData.mtimeMs);
    children.push({
      conversationId: meta.conversationId,
      kind: meta.kind,
      label: meta.label,
      runs: childData.parsed.runs,
      summary: summarizeRunsList(childData.parsed.runs),
    });
  }

  const allRuns = [
    ...mainData.parsed.runs,
    ...children.flatMap((c) => c.runs),
  ];

  return {
    conversationId: convId,
    found: true,
    updatedAt: maxMtime || Date.now(),
    ...mainData.parsed,
    mainSummary: summarizeRunsList(mainData.parsed.runs),
    subagentsSummary: summarizeRunsList(children.flatMap((c) => c.runs)),
    combinedSummary: summarizeRunsList(allRuns),
    children,
  };
}, 'GET');

app.api('/api/daily', (data) => {
  const today = toLocalDateKey(new Date().toISOString());
  const date = typeof data.date === 'string' && DATE_RE.test(data.date) ? data.date : today;
  return computeDailySummary(date);
}, 'GET');

app.page('/context.html', () => serveHtml('context.html'));

app.api('/api/report', async (data) => {
  try {
    return await getContextReport(data.conversationId || app.config.conversationId, data.workspace);
  } catch (err) {
    return { error: 'failed', message: err.message };
  }
}, 'POST');

app.api('/api/task-log', async (data) => {
  try {
    return await getTaskLog(data?.conversationId || app.config.conversationId, data?.stepIdx);
  } catch (err) {
    return { error: 'failed', message: err.message };
  }
}, 'POST');

app.run();
refreshCatalog();
