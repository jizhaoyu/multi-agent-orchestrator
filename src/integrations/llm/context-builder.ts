/**
 * 通用上下文构建器
 */

import type { LLMMessage } from './types';

export type MessageRole = LLMMessage['role'];
export type Message = LLMMessage;

export class ContextBuilder {
  private messages: Message[] = [];
  private systemPrompt: string | null = null;

  setSystemPrompt(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  addUserMessage(content: string): this {
    return this.addMessage('user', content);
  }

  addAssistantMessage(content: string): this {
    return this.addMessage('assistant', content);
  }

  addMessage(role: MessageRole, content: string): this {
    this.messages.push({ role, content });
    return this;
  }

  addMessages(messages: Message[]): this {
    this.messages.push(...messages);
    return this;
  }

  clear(): this {
    this.messages = [];
    this.systemPrompt = null;
    return this;
  }

  build(): {
    messages: Message[];
    system?: string;
  } {
    if (this.messages.length === 0) {
      throw new Error('At least one message is required');
    }

    if (this.messages[0]?.role !== 'user') {
      throw new Error('First message must be from user');
    }

    const result: {
      messages: Message[];
      system?: string;
    } = {
      messages: [...this.messages],
    };

    if (this.systemPrompt) {
      result.system = this.systemPrompt;
    }

    return result;
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  getMessages(): readonly Message[] {
    return [...this.messages];
  }

  getSystemPrompt(): string | null {
    return this.systemPrompt;
  }

  static fromMessages(messages: Message[], systemPrompt?: string): ContextBuilder {
    const builder = new ContextBuilder();
    builder.addMessages(messages);
    if (systemPrompt) {
      builder.setSystemPrompt(systemPrompt);
    }
    return builder;
  }

  static createSimple(userMessage: string, systemPrompt?: string): ContextBuilder {
    const builder = new ContextBuilder();
    builder.addUserMessage(userMessage);
    if (systemPrompt) {
      builder.setSystemPrompt(systemPrompt);
    }
    return builder;
  }
}
