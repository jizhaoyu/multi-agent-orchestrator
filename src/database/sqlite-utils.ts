import * as fs from 'fs';
import * as path from 'path';

let cachedSchema: string | null = null;

export function loadDatabaseSchema(): string {
  if (cachedSchema !== null) {
    return cachedSchema;
  }

  const candidatePaths = [
    path.join(__dirname, 'schema.sql'),
    path.join(__dirname, '../../src/database/schema.sql'),
  ];

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      cachedSchema = fs.readFileSync(candidatePath, 'utf-8');
      return cachedSchema;
    }
  }

  throw new Error('Database schema file not found');
}

export function buildTaskPriorityOrderSql(column = 'priority'): string {
  return `CASE ${column}
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
    ELSE 4
  END`;
}

export function parseJsonColumn<T>(value: string | null | undefined, fallback: T): T {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
