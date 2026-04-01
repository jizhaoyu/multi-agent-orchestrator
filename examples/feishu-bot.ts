/**
 * Feishu Bot 集成示例
 * 演示如何使用飞书事件订阅触发编排器执行
 */

import {
  Orchestrator,
  Worker,
  StateManager,
  TaskManager,
  MemoryService,
  createAPIClientFromEnv,
} from '../src';
import { FeishuBotIntegration } from '../src/integrations/feishu';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('🤖 Multi-Agent Orchestrator + Feishu Bot 示例\n');

  const hasWebhook = Boolean(process.env.FEISHU_WEBHOOK_URL);
  const hasAppCredentials = Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
  if (!hasWebhook && !hasAppCredentials) {
    console.error('❌ 错误: 请设置 FEISHU_WEBHOOK_URL，或同时设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
    process.exit(1);
  }

  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const apiClient = createAPIClientFromEnv();
  console.log(`🤖 当前 AI Provider: ${process.env.AI_PROVIDER || 'codex'}`);

  const stateManager = new StateManager({
    dbPath: path.join(dataDir, 'state.db'),
  });

  const taskManager = new TaskManager({
    dbPath: path.join(dataDir, 'tasks.db'),
  });

  const memoryService = new MemoryService({
    configRoot: resolveConfigRoot(),
    enableWatch: false,
  });

  const workers: Worker[] = [];
  const workspaceRoot = resolveWorkspaceRoot();
  const workerCount = readNumber(process.env.WORKER_COUNT) || 9;
  for (let i = 1; i <= workerCount; i++) {
    workers.push(
      new Worker({
        id: `worker-${i}`,
        apiClient,
        stateManager,
        taskManager,
        memoryService,
        workspaceRoot,
        enableWorkspaceExecution: process.env.ENABLE_WORKSPACE_EXECUTION !== 'false',
        maxExecutionIterations: readNumber(process.env.MAX_EXECUTION_ITERATIONS) || 6,
        commandTimeoutMs: readNumber(process.env.COMMAND_TIMEOUT_MS) || 120000,
      })
    );
  }

  const orchestrator = new Orchestrator({
    id: 'orchestrator-1',
    apiClient,
    stateManager,
    taskManager,
    memoryService,
    workers,
  });

  const feishuBot = new FeishuBotIntegration({
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    webhookSecret: process.env.FEISHU_WEBHOOK_SECRET,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
    defaultChatId: process.env.FEISHU_CHAT_ID,
    defaultWorkspaceRoot: workspaceRoot,
    host: process.env.FEISHU_EVENT_HOST,
    port: readNumber(process.env.FEISHU_EVENT_PORT) || 8788,
    eventPath: process.env.FEISHU_EVENT_PATH,
    executionUpdatesMode:
      process.env.FEISHU_EXECUTION_UPDATES_MODE === 'verbose' ? 'verbose' : 'silent',
    orchestrator,
    workers,
  });

  feishuBot.on('started', (event) => {
    console.log('✅ Feishu Bot 已启动');
    console.log(`🌐 回调地址: http://${event.host}:${event.port}${event.path}`);
    if (hasWebhook) {
      console.log('📨 已启用 Feishu webhook 推送');
    }
    console.log('');
  });

  feishuBot.on('user-message', (event) => {
    console.log(`📥 收到飞书消息: ${event.message}`);
  });

  console.log('▶️  启动系统...\n');

  await orchestrator.start();
  await feishuBot.start();

  process.on('SIGINT', async () => {
    console.log('\n\n🛑 正在停止系统...');

    await feishuBot.stop();
    await orchestrator.stop();

    await feishuBot.destroy();
    await orchestrator.destroy();

    for (const worker of workers) {
      await worker.destroy();
    }

    stateManager.close();
    taskManager.close();
    await memoryService.destroy();

    console.log('✅ 系统已停止');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('❌ 错误:', error);
  process.exit(1);
});

function resolveConfigRoot(): string {
  return process.env.CONFIG_ROOT || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function resolveWorkspaceRoot(): string {
  return process.env.WORKSPACE_ROOT || path.join(__dirname, '..');
}

function readNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
