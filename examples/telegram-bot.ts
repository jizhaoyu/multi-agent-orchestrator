/**
 * Telegram Bot 集成示例
 * 演示如何使用 Telegram Bot 进行可视化交互
 */

import {
  Orchestrator,
  Worker,
  StateManager,
  TaskManager,
  MemoryService,
  FeishuBotIntegration,
  createAPIClientFromEnv,
} from '../src';
import { TelegramBotIntegration } from '../src/integrations/telegram';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

async function main() {
  console.log('🤖 Multi-Agent Orchestrator + Telegram Bot 示例\n');

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('❌ 错误: 请设置 TELEGRAM_BOT_TOKEN 环境变量');
    process.exit(1);
  }

  // 1. 创建数据目录
  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 2. 初始化核心服务
  console.log('📦 初始化核心服务...');

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

  // 3. 创建 Workers
  console.log('👷 创建 9 个 Workers...');

  const workers: Worker[] = [];
  const workspaceRoot = resolveWorkspaceRoot();
  for (let i = 1; i <= 9; i++) {
    const worker = new Worker({
      id: `worker-${i}`,
      apiClient,
      stateManager,
      taskManager,
      memoryService,
      workspaceRoot,
      enableWorkspaceExecution: process.env.ENABLE_WORKSPACE_EXECUTION !== 'false',
      maxExecutionIterations: readNumber(process.env.MAX_EXECUTION_ITERATIONS) || 6,
      commandTimeoutMs: readNumber(process.env.COMMAND_TIMEOUT_MS) || 120000,
    });
    workers.push(worker);
  }

  // 4. 创建 Orchestrator
  console.log('🎯 创建 Orchestrator...');

  const orchestrator = new Orchestrator({
    id: 'orchestrator-1',
    apiClient,
    stateManager,
    taskManager,
    memoryService,
    workers,
  });

  // 5. 创建 Telegram Bot
  console.log('🤖 创建 Telegram Bot...');

  const telegramBot = new TelegramBotIntegration({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    defaultWorkspaceRoot: workspaceRoot,
    projectSearchRoots: resolveProjectSearchRoots(workspaceRoot),
    executionUpdatesMode: 'silent',
    proxyUrl:
      process.env.TELEGRAM_PROXY_URL ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY,
    orchestrator,
    workers,
  });

  const feishuNotifier = shouldEnableFeishuPush()
    ? new FeishuBotIntegration({
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
        webhookUrl: process.env.FEISHU_WEBHOOK_URL,
        defaultChatId: process.env.FEISHU_CHAT_ID,
        orchestrator,
        workers,
      })
    : null;

  // 监听 Bot 事件
  telegramBot.on('started', () => {
    console.log('✅ Telegram Bot 已启动');
    console.log('📱 请在 Telegram 中发送消息给 Bot');
    console.log('💡 示例: "帮我开发一个用户登录功能"\n');
  });

  telegramBot.on('user-message', (event) => {
    console.log(`📥 收到用户消息: ${event.message}`);
  });

  telegramBot.on('message-to-agent', (event) => {
    console.log(`📤 消息发送给 ${event.agentId}: ${event.message}`);
  });

  if (feishuNotifier) {
    telegramBot.on('final-summary', async (event) => {
      try {
        await feishuNotifier.sendNotification(event.content);
      } catch (error) {
        console.error('Feishu summary push failed:', error);
      }
    });

    telegramBot.on('execution-error', async (event) => {
      try {
        await feishuNotifier.sendNotification(
          ['⚠️ 任务异常', '', `聊天: ${event.chatId}`, `任务: ${event.taskId}`, event.error].join('\n')
        );
      } catch (error) {
        console.error('Feishu error push failed:', error);
      }
    });
  }

  // 6. 启动系统
  console.log('▶️  启动系统...\n');

  await orchestrator.start();
  await telegramBot.start();

  console.log('✅ 系统已启动！');
  console.log('🔄 Bot 正在运行，按 Ctrl+C 停止...\n');

  // 7. 处理退出信号
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 正在停止系统...');

    await telegramBot.stop();
    await orchestrator.stop();

    await telegramBot.destroy();
    if (feishuNotifier) {
      await feishuNotifier.destroy();
    }
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

// 运行示例
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

function resolveProjectSearchRoots(workspaceRoot: string): string[] {
  const configuredRoots = process.env.PROJECT_SEARCH_ROOTS;
  if (!configuredRoots) {
    return [path.dirname(workspaceRoot)];
  }

  return configuredRoots
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function readNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shouldEnableFeishuPush(): boolean {
  if (process.env.FEISHU_WEBHOOK_URL) {
    return true;
  }

  return Boolean(
    process.env.FEISHU_APP_ID &&
      process.env.FEISHU_APP_SECRET &&
      process.env.FEISHU_CHAT_ID
  );
}
