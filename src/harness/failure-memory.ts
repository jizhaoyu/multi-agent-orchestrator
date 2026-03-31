import * as fs from 'fs/promises';
import * as path from 'path';
import type { FailureRecord } from './types';

export interface FailureMemoryStoreConfig {
  workspaceRoot: string;
  relativePath?: string;
}

export class FailureMemoryStore {
  private readonly workspaceRoot: string;
  private readonly relativePath: string;

  constructor(config: FailureMemoryStoreConfig) {
    this.workspaceRoot = config.workspaceRoot;
    this.relativePath = config.relativePath || 'docs/failure-catalog.md';
  }

  async append(record: FailureRecord): Promise<void> {
    const fullPath = path.join(this.workspaceRoot, this.relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    let current = '';
    try {
      current = await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (!current.trim()) {
      current = '# Failure Catalog\n\n记录高频失败模式、修复策略和需要补进 Harness 的改进。\n';
    }

    const nextContent = `${current.trimEnd()}\n\n${formatFailureRecord(record)}\n`;
    await fs.writeFile(fullPath, nextContent, 'utf-8');
  }

  async getRecentSummaries(limit = 3): Promise<string[]> {
    const fullPath = path.join(this.workspaceRoot, this.relativePath);
    let content = '';

    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return content
      .split(/^## /gm)
      .map((section) => section.trim())
      .filter(Boolean)
      .slice(-limit)
      .map((section) => `## ${section}`.trim());
  }
}

function formatFailureRecord(record: FailureRecord): string {
  return [
    `## ${record.timestamp} | ${sanitizeInline(record.rootCause)}`,
    `- 任务类型: ${sanitizeInline(record.taskType)}`,
    `- 触发条件: ${sanitizeInline(record.trigger)}`,
    `- 错误输出: ${sanitizeMultiline(record.errorOutput)}`,
    `- 修复策略: ${sanitizeMultiline(record.repairStrategy)}`,
    `- Harness 改进: ${sanitizeMultiline(record.harnessFix)}`,
    `- Repro 检查: ${sanitizeInline(record.reproCheck)}`,
    record.traceId ? `- Trace ID: ${sanitizeInline(record.traceId)}` : '',
    record.attemptId ? `- Attempt ID: ${sanitizeInline(record.attemptId)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sanitizeMultiline(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' / ');
}
