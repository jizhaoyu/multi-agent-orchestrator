import { MemoryService } from './memory-service';

interface WorkerInstructionContextConfig {
  memoryService: MemoryService;
  instructionFiles: string[];
  maxInstructionContextChars: number;
}

export class WorkerInstructionContext {
  private readonly config: WorkerInstructionContextConfig;
  private cachedContext: string | null | undefined;
  private readonly invalidateCachedContext = (): void => {
    this.cachedContext = undefined;
  };

  constructor(config: WorkerInstructionContextConfig) {
    this.config = config;

    for (const relativePath of this.config.instructionFiles) {
      this.config.memoryService.subscribe(relativePath, this.invalidateCachedContext);
    }
  }

  async read(): Promise<string | null> {
    if (this.cachedContext !== undefined) {
      return this.cachedContext;
    }

    const sections: string[] = [];
    let totalChars = 0;

    for (const relativePath of this.config.instructionFiles) {
      try {
        const data = await this.config.memoryService.read(relativePath);
        const content =
          typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        const remaining = this.config.maxInstructionContextChars - totalChars;
        if (remaining <= 0) {
          break;
        }

        const clipped =
          content.length > remaining
            ? `${content.slice(0, remaining)}\n...[truncated]`
            : content;
        sections.push(`--- ${relativePath} ---\n${clipped}\n---`);
        totalChars += clipped.length;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('Memory file not found:')
        ) {
          continue;
        }
        throw error;
      }
    }

    this.cachedContext = sections.length === 0 ? null : sections.join('\n\n');
    return this.cachedContext;
  }

  destroy(): void {
    for (const relativePath of this.config.instructionFiles) {
      this.config.memoryService.unsubscribe(relativePath, this.invalidateCachedContext);
    }
    this.cachedContext = undefined;
  }
}
