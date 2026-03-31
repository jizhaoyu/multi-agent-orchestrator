import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const targetRoot = path.resolve(process.argv[2] || process.cwd());
const templateRoot = path.resolve(process.cwd(), 'templates', 'codex-harness');

await mkdir(targetRoot, { recursive: true });
await copyDirectory(templateRoot, targetRoot);

console.log(`Codex harness starter initialized at ${targetRoot}`);
console.log('Next steps:');
console.log('1. Review AGENTS.md and codex-harness.config.json');
console.log('2. Wire project-specific verify commands into the verification policy');
console.log('3. Run your verifier and add at least one benchmark result fixture');

async function copyDirectory(sourceDir, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
      continue;
    }

    if (!(await exists(destinationPath))) {
      await cp(sourcePath, destinationPath);
    }
  }
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
