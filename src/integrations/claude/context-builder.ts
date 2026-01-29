/**
 * 上下文构建器
 * 用于构建 Claude API 的消息上下文
 */

import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant';

/**
 * 消息内容
 */
export interface Message {
  role: MessageRole;
  content: string;
}

/**
 * 上下文构建器
 */
export class ContextBuilder {
  private messages: Message[] = [];
  private systemPrompt: string | null = null;

  /**
   * 设置系统提示词
   */
  setSystemPrompt(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  /**
   * 添加用户消息
   */
  addUserMessage(content: string): this {
    this.messages.push({
      role: 'user',
      content,
    });
    return this;
  }

  /**
   * 添加助手消息
   */
  addAssistantMessage(content: string): this {
    this.messages.push({
      role: 'assistant',
      content,
    });
    return this;
  }

  /**
   * 添加消息
   */
  addMessage(role: MessageRole, content: string): this {
    this.messages.push({ role, content });
    return this;
  }

  /**
   * 添加多条消息
   */
  addMessages(messages: Message[]): this {
    this.messages.push(...messages);
    return this;
  }

  /**
   * 清空消息
   */
  clear(): this {
    this.messages = [];
    this.systemPrompt = null;
    return this;
  }

  /**
   * 构建 API 参数
   */
  build(): {
    messages: MessageCreateParams['messages'];
    system?: string;
  } {
    // 确保消息以 user 开头
    if (this.messages.length === 0) {
      throw new Error('At least one message is required');
    }

    if (this.messages[0]?.role !== 'user') {
      throw new Error('First message must be from user');
    }

    // 转换为 API 格式
    const apiMessages: MessageCreateParams['messages'] = this.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const result: {
      messages: MessageCreateParams['messages'];
      system?: string;
    } = {
      messages: apiMessages,
    };

    if (this.systemPrompt) {
      result.system = this.systemPrompt;
    }

    return result;
  }

  /**
   * 获取消息数量
   */
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * 获取所有消息
   */
  getMessages(): readonly Message[] {
    return [...this.messages];
  }

  /**
   * 获取系统提示词
   */
  getSystemPrompt(): string | null {
    return this.systemPrompt;
  }

  /**
   * 从现有上下文创建构建器
   */
  static fromMessages(messages: Message[], systemPrompt?: string): ContextBuilder {
    const builder = new ContextBuilder();
    builder.addMessages(messages);
    if (systemPrompt) {
      builder.setSystemPrompt(systemPrompt);
    }
    return builder;
  }

  /**
   * 创建简单的单轮对话上下文
   */
  static createSimple(userMessage: string, systemPrompt?: string): ContextBuilder {
    const builder = new ContextBuilder();
    builder.addUserMessage(userMessage);
    if (systemPrompt) {
      builder.setSystemPrompt(systemPrompt);
    }
    return builder;
  }
}
