// 轻量级 Hook 采集脚本：记录每次模型调用与工具/停止边界的毫秒级时间戳
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf-8');
  } catch {
    process.stdout.write('{}');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write('{}');
    return;
  }

  const eventName = payload.hookEventName || '';
  const artifactDir = payload.artifactDirectoryPath;
  const timingPath = artifactDir
    ? join(artifactDir, '.system_generated', 'logs', 'run_telemetry.jsonl')
    : null;

  if (timingPath) {
    const record = {
      ts: Date.now(),
      event: eventName,
      conversationId: payload.conversationId || '',
      invocationNum: payload.invocationNum ?? null,
      initialNumSteps: payload.initialNumSteps ?? null,
      stepIdx: payload.stepIdx ?? null,
      executionNum: payload.executionNum ?? null,
      terminationReason: payload.terminationReason || null,
      modelName: payload.modelName || null,
    };
    try {
      mkdirSync(dirname(timingPath), { recursive: true });
      appendFileSync(timingPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch {
      // 不阻塞 Agent 主流程
    }
  }

  if (eventName === 'PreToolUse') {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  process.stdout.write('{}');
}

main();
