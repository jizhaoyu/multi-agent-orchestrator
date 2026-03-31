import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { TraceEvent } from './types';

export interface TraceRecorderConfig {
  outputPath?: string;
  onEvent?: (event: TraceEvent) => void | Promise<void>;
}

export class TraceRecorder {
  private readonly config: TraceRecorderConfig;
  private readonly events: TraceEvent[] = [];

  constructor(config: TraceRecorderConfig = {}) {
    this.config = config;
  }

  async record(event: Omit<TraceEvent, 'timestamp'>): Promise<TraceEvent> {
    const normalized: TraceEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    this.events.push(normalized);

    if (this.config.outputPath) {
      const outputPath = path.resolve(this.config.outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.appendFile(outputPath, `${JSON.stringify(normalized)}\n`, 'utf-8');
    }

    if (this.config.onEvent) {
      await this.config.onEvent(normalized);
    }

    return normalized;
  }

  getEvents(): TraceEvent[] {
    return [...this.events];
  }
}

export function createTraceId(prefix = 'trace'): string {
  return `${prefix}-${randomUUID()}`;
}
