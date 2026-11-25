/**
 * 共享遥测解析模块：供 Hook 与 Sidecar 共同使用。
 */
import { existsSync, readFileSync } from 'node:fs';

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

    for (const s of run.steps) {
      inputTokens += s.inputTokens;
      outputTokens += s.outputTokens;
      cacheReadTokens += s.cacheReadTokens;
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
