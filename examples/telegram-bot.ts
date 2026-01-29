/**
 * Telegram Bot 集成示例
 * 演示如何使用 Telegram Bot 进行可视化交互
 */

import {
  Orchestrator,
  Worker,
  ClaudeAPIClient,
  StateManager,
  TaskManager,
  MemoryService,
} from '../src';
import { TelegramBotIntegration } from '../src/integrations/telegram';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

async function main() {
  console.log('🤖 Multi-Agent Orchestrator + Telegram Bot 示例\n');

  // 检查必要的环境变量
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ 错误: 请设置 ANTHROPIC_API_KEY 环境变量');
    process.exit(1);
  }

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

  const apiClient = new ClaudeAPIClient({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-opus-4-5',
    maxTokens: 200000,
  });

  const stateManager = new StateManager({
    dbPath: path.join(dataDir, 'state.db'),
  });

  const taskManager = new TaskManager({
    dbPath: path.join(dataDir, 'tasks.db'),
  });

  const memoryService = new MemoryService({
    configRoot: process.env.CONFIG_ROOT || path.join(process.env.HOME || '~', '.claude'),
    enableWatch: false,
  });

  // 3. 创建 Workers
  console.log('👷 创建 9 个 Workers...');

  const workers: Worker[] = [];
  for (let i = 1; i <= 9; i++) {
    const worker = new Worker({
      id: `worker-${i}`,
      apiClient,
      stateManager,
      taskManager,
      memoryService,
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
    orchestrator,
    workers,
  });

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
