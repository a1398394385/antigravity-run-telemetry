/**
 * Run Telemetry Sidecar Backend
 * 复用 lib/telemetry.mjs 解析当前对话的每轮 Agent RUN 耗时、速度与 4 项 token。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp } from 'sidecar_sdk';
import { parseRuns, readJsonl } from '../../lib/telemetry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;

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

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

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

app.run();
