/**
 * Multi-Agent Orchestrator 基础使用示例
 * 演示如何创建和使用 Orchestrator 和 Workers
 */

import {
  Orchestrator,
  Worker,
  ClaudeAPIClient,
  StateManager,
  TaskManager,
  MemoryService,
} from '../src';
import * as path from 'path';
import * as fs from 'fs';

async function main() {
  console.log('🚀 Multi-Agent Orchestrator 示例\n');

  // 1. 创建数据目录
  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 2. 初始化核心服务
  console.log('📦 初始化核心服务...');

  const apiClient = new ClaudeAPIClient({
    apiKey: process.env.ANTHROPIC_API_KEY || 'your-api-key',
    model: 'claude-opus-4-5',
    maxTokens: 200000,
  });

  const stateManager = new StateManager({
    dbPath: path.join(dataDir, 'state.db'),
    heartbeatTimeout: 10 * 60 * 1000, // 10 分钟
  });

  const taskManager = new TaskManager({
    dbPath: path.join(dataDir, 'tasks.db'),
    maxDepth: 3,
  });

  const memoryService = new MemoryService({
    configRoot: process.env.CONFIG_ROOT || path.join(process.env.HOME || '~', '.claude'),
    cacheSize: 100,
    enableWatch: false, // 示例中禁用文件监听
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

    // 监听 Worker 事件
    worker.on('task-received', (task) => {
      console.log(`  ✅ Worker ${i} 接收任务: ${task.description}`);
    });

    worker.on('task-completed', (task) => {
      console.log(`  ✅ Worker ${i} 完成任务: ${task.description}`);
    });

    worker.on('task-failed', (task, error) => {
      console.log(`  ❌ Worker ${i} 任务失败: ${task.description}`);
      console.log(`     错误: ${error}`);
    });

    worker.on('progress', (event) => {
      if (event.progress >= 0) {
        console.log(`  📊 Worker ${i} 进度: ${event.progress}% - ${event.message}`);
      }
    });

    workers.push(worker);
  }

  // 4. 创建 Orchestrator
  console.log('🎯 创建 Orchestrator...\n');

  const orchestrator = new Orchestrator({
    id: 'orchestrator-1',
    apiClient,
    stateManager,
    taskManager,
    memoryService,
    workers,
  });

  // 监听 Orchestrator 事件
  orchestrator.on('task-received', (task) => {
    console.log(`📥 Orchestrator 接收任务: ${task.description}`);
  });

  orchestrator.on('task-decomposed', (task, subtasks) => {
    console.log(`🔨 任务已分解为 ${subtasks.length} 个子任务:`);
    subtasks.forEach((subtask, index) => {
      console.log(`   ${index + 1}. ${subtask.description} (优先级: ${subtask.priority})`);
    });
  });

  orchestrator.on('task-assigned', (task, worker) => {
    console.log(`📤 任务已分配: ${task.description} → Worker ${worker.id}`);
  });

  orchestrator.on('progress-report', (stats) => {
    console.log(`\n📊 进度报告:`);
    console.log(`   总任务: ${stats.total}`);
    console.log(`   待处理: ${stats.pending}`);
    console.log(`   进行中: ${stats.running}`);
    console.log(`   已完成: ${stats.completed}`);
    console.log(`   失败: ${stats.failed}\n`);
  });

  // 5. 启动 Orchestrator
  console.log('▶️  启动 Orchestrator...\n');
  await orchestrator.start();

  // 6. 接收用户任务
  console.log('📝 接收用户任务...\n');

  const userTask = await orchestrator.receiveTask(
    '开发一个用户登录功能，包括前端页面和后端 API'
  );

  console.log(`✅ 任务已创建: ${userTask.id}\n`);

  // 7. 分解任务
  console.log('🔨 分解任务...\n');

  const subtasks = await orchestrator.decomposeTask(userTask);

  console.log(`✅ 任务已分解为 ${subtasks.length} 个子任务\n`);

  // 8. 分配任务
  console.log('📤 分配任务给 Workers...\n');

  await orchestrator.assignTasks(subtasks);

  console.log(`✅ 任务已分配\n`);

  // 9. 等待一段时间让任务执行
  console.log('⏳ 等待任务执行...\n');

  await new Promise((resolve) => setTimeout(resolve, 5000));

  // 10. 获取任务统计
  const stats = taskManager.getStats();
  console.log('📊 最终统计:');
  console.log(`   总任务: ${stats.total}`);
  console.log(`   待处理: ${stats.pending}`);
  console.log(`   进行中: ${stats.running}`);
  console.log(`   已完成: ${stats.completed}`);
  console.log(`   失败: ${stats.failed}\n`);

  // 11. 清理资源
  console.log('🧹 清理资源...');

  await orchestrator.stop();
  await orchestrator.destroy();

  for (const worker of workers) {
    await worker.destroy();
  }

  stateManager.close();
  taskManager.close();
  await memoryService.destroy();

  console.log('✅ 示例完成！');
}

// 运行示例
main().catch((error) => {
  console.error('❌ 错误:', error);
  process.exit(1);
});
