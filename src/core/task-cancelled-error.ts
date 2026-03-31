export class TaskCancelledError extends Error {
  constructor(message = '任务已被取消') {
    super(message);
    this.name = 'TaskCancelledError';
  }
}

export function isTaskCancelledError(error: unknown): error is TaskCancelledError {
  if (error instanceof TaskCancelledError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'TaskCancelledError' || error.message.includes('任务已被取消');
}

export function toTaskCancelledError(reason?: unknown): TaskCancelledError {
  if (reason instanceof TaskCancelledError) {
    return reason;
  }

  if (reason instanceof Error) {
    return new TaskCancelledError(reason.message || '任务已被取消');
  }

  if (typeof reason === 'string' && reason.trim()) {
    return new TaskCancelledError(reason.trim());
  }

  return new TaskCancelledError();
}
