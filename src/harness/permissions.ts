import type { PermissionProfile } from './types';

interface PermissionProfileDefinition {
  name: PermissionProfile;
  description: string;
  allowedPatterns: RegExp[];
}

const DENIED_PATTERNS = [
  /(^|\s)git\s+reset\s+--hard\b/i,
  /(^|\s)git\s+clean\s+-fd/i,
  /(^|\s)git\s+checkout\s+--\b/i,
  /(^|\s)rm\s+-rf\b/i,
  /(^|\s)rmdir\b/i,
  /(^|\s)del\s+\/f\b/i,
  /(^|\s)npm\s+(install|update|remove|publish|login|logout|version)\b/i,
  /(^|\s)pnpm\s+(add|install|update|remove|publish)\b/i,
  /(^|\s)yarn\s+(add|install|up|remove|publish)\b/i,
  /(^|\s)bun\s+(add|install|remove|publish)\b/i,
  /(^|\s)(curl|wget)\b/i,
  /(^|\s)(shutdown|reboot|mkfs|format)\b/i,
  /(^|\s)(vi|vim|nano)\b/i,
];

const READ_ONLY_PATTERNS = [
  /^git\s+(status|diff|log|show|rev-parse|branch\s+--show-current)\b/i,
  /^rg\b/i,
  /^ls\b/i,
  /^dir\b/i,
  /^Get-ChildItem\b/i,
  /^cat\b/i,
  /^type\b/i,
  /^echo\b/i,
];

const DEV_SAFE_PATTERNS = [
  ...READ_ONLY_PATTERNS,
  /^node\s+-e\b/i,
  /^npm\s+(test|run\s+(verify|lint|typecheck|build|test|test:coverage|format:check|benchmark|benchmarks|check))\b/i,
  /^pnpm\s+(test|run\s+(verify|lint|typecheck|build|test|test:coverage|format:check|benchmark|benchmarks|check))\b/i,
  /^yarn\s+((run\s+)?(verify|lint|typecheck|build|test|test:coverage|format:check|benchmark|benchmarks|check))\b/i,
  /^bun\s+(run\s+)?(verify|lint|typecheck|build|test|test:coverage|format:check|benchmark|benchmarks|check)\b/i,
  /^npx\s+(eslint|prettier|vitest|jest|tsc|biome|tsx)\b/i,
  /^eslint\b/i,
  /^prettier\s+--check\b/i,
  /^tsc\b/i,
  /^vitest\b/i,
  /^jest\b/i,
  /^pytest\b/i,
  /^python\s+-m\s+pytest\b/i,
  /^cargo\s+(test|check|clippy|fmt\s+--check)\b/i,
  /^go\s+(test|vet)\b/i,
  /^(gradle|\.\/gradlew)\s+(test|build|check)\b/i,
  /^(mvn|\.\/mvnw)\s+(test|verify|package)\b/i,
  /^dotnet\s+(test|build)\b/i,
];

const PROFILE_DEFINITIONS: Record<PermissionProfile, PermissionProfileDefinition> = {
  read_only: {
    name: 'read_only',
    description: 'Only repo inspection commands are allowed.',
    allowedPatterns: READ_ONLY_PATTERNS,
  },
  dev_safe: {
    name: 'dev_safe',
    description: 'Allows read-only inspection plus non-mutating dev verification commands.',
    allowedPatterns: DEV_SAFE_PATTERNS,
  },
  repo_write: {
    name: 'repo_write',
    description: 'Uses the same command allowlist as dev_safe; file writes happen via tools, not shell.',
    allowedPatterns: DEV_SAFE_PATTERNS,
  },
  network_limited: {
    name: 'network_limited',
    description: 'Reserved for future GET-only network tooling; shell networking remains blocked.',
    allowedPatterns: DEV_SAFE_PATTERNS,
  },
  privileged_ops: {
    name: 'privileged_ops',
    description: 'Reserved for explicitly approved maintenance commands.',
    allowedPatterns: DEV_SAFE_PATTERNS,
  },
};

export function getPermissionProfileDefinition(
  profile: PermissionProfile = 'dev_safe'
): PermissionProfileDefinition {
  return PROFILE_DEFINITIONS[profile];
}

export function assertCommandAllowed(
  command: string,
  profile: PermissionProfile = 'dev_safe'
): void {
  const normalized = command.trim();
  if (!normalized) {
    throw new Error('命令不能为空。');
  }

  if (DENIED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error(`命令被权限策略阻止: ${command}`);
  }

  const definition = getPermissionProfileDefinition(profile);
  if (!definition.allowedPatterns.some((pattern) => pattern.test(normalized))) {
    throw new Error(
      `命令不在 ${definition.name} 权限档位允许列表中: ${command}`
    );
  }
}

export function isCommandAllowed(
  command: string,
  profile: PermissionProfile = 'dev_safe'
): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }

  if (DENIED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const definition = getPermissionProfileDefinition(profile);
  return definition.allowedPatterns.some((pattern) => pattern.test(normalized));
}
