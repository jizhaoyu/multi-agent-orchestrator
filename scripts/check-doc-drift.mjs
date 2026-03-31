import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const targetRoot = path.resolve(process.argv[2] || process.cwd());
const requiredFiles = [
  'AGENTS.md',
  'docs/agent-map.md',
  'docs/failure-catalog.md',
  'docs/runbooks/verification.md',
  'codex-harness.config.json',
];

let failures = 0;

for (const relativePath of requiredFiles) {
  const fullPath = path.join(targetRoot, relativePath);
  if (!(await exists(fullPath))) {
    failures++;
    console.error(`Missing required harness file: ${relativePath}`);
  }
}

const agentsPath = path.join(targetRoot, 'AGENTS.md');
if (await exists(agentsPath)) {
  const content = await readFile(agentsPath, 'utf-8');
  for (const heading of ['项目地图', '常用命令', '验证命令', '安全边界', '禁改区域', '文档入口']) {
    if (!content.includes(`## ${heading}`)) {
      failures++;
      console.error(`AGENTS.md missing section: ${heading}`);
    }
  }
}

const packageJsonPath = path.join(targetRoot, 'package.json');
if (await exists(packageJsonPath)) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
  for (const scriptName of ['verify', 'lint']) {
    if (!packageJson.scripts?.[scriptName]) {
      failures++;
      console.error(`package.json missing script: ${scriptName}`);
    }
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log('Harness docs look consistent.');
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
