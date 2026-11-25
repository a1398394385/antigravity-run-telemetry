/**
 * 共享遥测解析模块：供 Hook 与 Sidecar 共同使用。
 */
import { existsSync, readFileSync } from 'node:fs';

// Gemini 系列模型官方公开定价（单位：USD / 1M tokens）
const GEMINI_PRICING = [
  {
    prefix: 'gemini-4-neon',
    tiers: [{ maxContext: Infinity, input: 3.0, output: 15.0, cacheRead: 0.15 }],
  },
  {
    prefix: 'gemini-4-hydrogen',
    tiers: [{ maxContext: Infinity, input: 1.5, output: 7.5, cacheRead: 0.075 }],
  },
  {
    prefix: 'gemini-4-argon',
    tiers: [{ maxContext: Infinity, input: 2.0, output: 10.0, cacheRead: 0.1 }],
  },
  {
    prefix: 'gemini-4-carbon',
    tiers: [{ maxContext: Infinity, input: 2.0, output: 10.0, cacheRead: 0.1 }],
  },
  {
    prefix: 'gemini-3.8-flash',
    tiers: [{ maxContext: Infinity, input: 0.75, output: 3.75, cacheRead: 0.075 }],
  },
  {
    prefix: 'gemini-3.6-flash',
    tiers: [{ maxContext: Infinity, input: 0.75, output: 3.75, cacheRead: 0.075 }],
  },
  {
    prefix: 'gemini-3.1-pro',
    tiers: [
      { maxContext: 200_000, input: 2.0, output: 12.0, cacheRead: 0.2 },
      { maxContext: Infinity, input: 4.0, output: 18.0, cacheRead: 0.4 },
    ],
  },
  {
    prefix: 'gemini-3-pro',
    tiers: [
      { maxContext: 200_000, input: 2.0, output: 12.0, cacheRead: 0.2 },
      { maxContext: Infinity, input: 4.0, output: 18.0, cacheRead: 0.4 },
    ],
  },
  {
    prefix: 'gemini-2.5-pro',
    tiers: [
      { maxContext: 200_000, input: 1.25, output: 10.0, cacheRead: 0.125 },
      { maxContext: Infinity, input: 2.5, output: 15.0, cacheRead: 0.25 },
    ],
  },
  {
    prefix: 'gemini-2.5-flash-lite',
    tiers: [{ maxContext: Infinity, input: 0.1, output: 0.4, cacheRead: 0.01 }],
  },
  {
    prefix: 'gemini-2.5-flash',
    tiers: [{ maxContext: Infinity, input: 0.3, output: 2.5, cacheRead: 0.03 }],
  },
];

export function estimateStepCostUsd(step) {
  const model = String(step.model || '').toLowerCase();
  const entry = GEMINI_PRICING.find((p) => model.startsWith(p.prefix));
  if (!entry) return null;
  const contextTokens = (step.inputTokens || 0) + (step.cacheReadTokens || 0);
  const tier = entry.tiers.find((t) => contextTokens <= t.maxContext) || entry.tiers[entry.tiers.length - 1];
  return (
    (step.inputTokens || 0) * tier.input +
    (step.outputTokens || 0) * tier.output +
    (step.cacheReadTokens || 0) * tier.cacheRead
  ) / 1_000_000;
}

export function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const items = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed));
      } catch {
        // 忽略半截写入行
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function buildInvocationSpans(timingEvents) {
  const spans = [];
  let pendingPre = null;

  for (const ev of timingEvents) {
    if (ev.event === 'PreInvocation') {
      pendingPre = ev;
      continue;
    }
    if (pendingPre && (ev.event === 'PreToolUse' || ev.event === 'PostInvocation' || ev.event === 'Stop')) {
      const durationMs = Math.max(0, (ev.ts || 0) - (pendingPre.ts || 0));
      spans.push({
        startTs: pendingPre.ts,
        endTs: ev.ts,
        durationMs,
        initialNumSteps: pendingPre.initialNumSteps,
        invocationNum: pendingPre.invocationNum,
      });
      pendingPre = null;
    }
  }

  const isRunning = pendingPre !== null;
  const activeStartTs = pendingPre?.ts || null;
  return { spans, isRunning, activeStartTs };
}

function extractPromptFirstLine(rawContent) {
  if (typeof rawContent !== 'string') return '';
  const reqMatch = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const body = (reqMatch ? reqMatch[1] : rawContent)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '')
    .trim();
  if (!body) return '';
  const firstLine = body.split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  return firstLine.length > 64 ? `${firstLine.slice(0, 64)}…` : firstLine;
}

export function parseRuns(transcriptRows, timingEvents) {
  const { spans, isRunning, activeStartTs } = buildInvocationSpans(timingEvents);

  const runs = [];
  let current = null;

  for (const row of transcriptRows) {
    if (row.type === 'USER_INPUT' || row.source === 'USER_EXPLICIT' || row.source === 'USER') {
      if (current) runs.push(current);
      current = {
        runIndex: runs.length + 1,
        promptPreview: extractPromptFirstLine(row.content),
        startedAt: row.created_at || null,
        userStepIndex: row.step_index ?? null,
        steps: [],
      };
    } else if (row.source === 'MODEL' && (row.input_tokens !== undefined || row.output_tokens !== undefined)) {
      if (!current) {
        current = {
          runIndex: 1,
          promptPreview: 'Initial run',
          startedAt: row.created_at || null,
          userStepIndex: 0,
          steps: [],
        };
      }
      current.steps.push({
        stepIndex: row.step_index ?? null,
        model: row.model || 'unknown',
        createdAt: row.created_at || null,
        inputTokens: Number(row.input_tokens) || 0,
        cacheReadTokens: Number(row.cache_read_tokens) || 0,
        outputTokens: Number(row.output_tokens) || 0,
      });
    }
  }
  if (current) runs.push(current);

  const usedSpans = new Set();
  for (const run of runs) {
    for (const step of run.steps) {
      let matched = null;
      let matchedIdx = -1;

      if (step.stepIndex !== null) {
        for (let i = 0; i < spans.length; i++) {
          if (usedSpans.has(i)) continue;
          const sp = spans[i];
          if (typeof sp.initialNumSteps === 'number' && sp.initialNumSteps <= step.stepIndex) {
            matched = sp;
            matchedIdx = i;
            if (step.stepIndex - sp.initialNumSteps <= 2) break;
          }
        }
      }

      if (matchedIdx !== -1 && matched) {
        usedSpans.add(matchedIdx);
        step.latencyMs = matched.durationMs;
        step.tps = matched.durationMs > 0
          ? Number(((step.outputTokens / matched.durationMs) * 1000).toFixed(1))
          : null;
      } else {
        step.latencyMs = null;
        step.tps = null;
      }
    }
  }

  const summarized = runs.map((run, idx) => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let timedMs = 0;
    let timedOutputTokens = 0;
    let timedSteps = 0;
    let costUsd = 0;
    let hasPricedStep = false;

    for (const s of run.steps) {
      inputTokens += s.inputTokens;
      outputTokens += s.outputTokens;
      cacheReadTokens += s.cacheReadTokens;
      const stepCost = estimateStepCostUsd(s);
      if (stepCost !== null) {
        s.costUsd = stepCost;
        costUsd += stepCost;
        hasPricedStep = true;
      } else {
        s.costUsd = null;
      }
      if (s.latencyMs !== null && s.latencyMs > 0) {
        timedMs += s.latencyMs;
        timedOutputTokens += s.outputTokens;
        timedSteps += 1;
      }
    }

    const totalTokens = inputTokens + outputTokens + cacheReadTokens;
    const cacheDenominator = inputTokens + cacheReadTokens;
    const cacheHitRate = cacheDenominator > 0
      ? Number(((cacheReadTokens / cacheDenominator) * 100).toFixed(1))
      : 0;
    const avgLatencyMs = timedSteps > 0 ? Math.round(timedMs / timedSteps) : null;
    const effectiveTps = timedMs > 0
      ? Number(((timedOutputTokens / timedMs) * 1000).toFixed(1))
      : null;

    const isLatest = idx === runs.length - 1;
    return {
      ...run,
      stepCount: run.steps.length,
      timedSteps,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens,
      costUsd: hasPricedStep ? costUsd : null,
      cacheHitRate,
      avgLatencyMs,
      effectiveTps,
      isRunning: isLatest && isRunning,
      activeElapsedMs: isLatest && isRunning && activeStartTs ? Math.max(0, Date.now() - activeStartTs) : null,
    };
  });

  return {
    runs: summarized,
    hasTimingData: spans.length > 0 || isRunning,
    isRunning,
  };
}

export function fmtK(n) {
  if (n === null || n === undefined) return '—';
  const num = Number(n);
  return num >= 1000 ? `${(num / 1000).toFixed(1)}K` : String(num);
}

export function fmtLatency(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function toLocalDateKey(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 将单个会话的 runs 按本地日期分桶并按模型聚合，供每日汇总视图缓存复用。
 * 返回格式：{ [dateKey]: { [model]: { stepCount, timedSteps, timedMs, timedOutputTokens, inputTokens, outputTokens, cacheReadTokens, costUsd, hasPricedStep } } }
 */
export function buildSessionDailyBuckets(transcriptRows, timingEvents) {
  const { runs } = parseRuns(transcriptRows, timingEvents);
  const buckets = Object.create(null);

  for (const run of runs) {
    for (const s of run.steps) {
      const dateKey = toLocalDateKey(s.createdAt) || toLocalDateKey(run.startedAt);
      if (!dateKey) continue;
      if (!buckets[dateKey]) buckets[dateKey] = Object.create(null);
      const model = s.model || 'unknown';
      if (!buckets[dateKey][model]) {
        buckets[dateKey][model] = {
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
      }
      const m = buckets[dateKey][model];
      m.stepCount += 1;
      m.inputTokens += s.inputTokens || 0;
      m.outputTokens += s.outputTokens || 0;
      m.cacheReadTokens += s.cacheReadTokens || 0;
      if (s.costUsd !== null && s.costUsd !== undefined) {
        m.costUsd += s.costUsd;
        m.hasPricedStep = true;
      }
      if (s.latencyMs !== null && s.latencyMs > 0) {
        m.timedSteps += 1;
        m.timedMs += s.latencyMs;
        m.timedOutputTokens += s.outputTokens || 0;
      }
    }
  }

  return buckets;
}
