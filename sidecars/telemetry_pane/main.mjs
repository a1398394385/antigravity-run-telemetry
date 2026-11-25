/**
 * Run Telemetry Sidecar Backend
 * 复用 lib/telemetry.mjs 解析单会话每轮 Agent RUN 与跨会话每日汇总数据。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { buildSessionDailyBuckets, parseRuns, readJsonl, toLocalDateKey } from '../../lib/telemetry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 会话级增量缓存：key = logsDir -> { transcriptMtime, transcriptSize, timingMtime, timingSize, buckets }
const dailySessionCache = new Map();

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

const app = new SidecarApp();

app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
  contentType: 'text/html; charset=utf-8',
  headers: { 'Cache-Control': 'no-store' },
}));

app.api('/api/telemetry', (data) => {
  const convId = data.conversationId || app.config.conversationId || '';
  if (!convId || !ID_RE.test(convId)) {
    return { conversationId: convId || null, found: false, runs: [] };
  }

  const logsDir = resolveLogsDir(convId);
  if (!logsDir) {
    return { conversationId: convId, found: false, runs: [] };
  }

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
  return {
    conversationId: convId,
    found: true,
    updatedAt: mtimeMs || Date.now(),
    ...parsed,
  };
}, 'GET');

app.api('/api/daily', (data) => {
  const today = toLocalDateKey(new Date().toISOString());
  const date = typeof data.date === 'string' && DATE_RE.test(data.date) ? data.date : today;
  return computeDailySummary(date);
}, 'GET');

app.run();
