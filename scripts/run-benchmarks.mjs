import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const benchmarkRoot = path.resolve(process.argv[2] || 'benchmarks');
const resultRoot = path.join(benchmarkRoot, 'results');

const caseFiles = (await safeReadDir(benchmarkRoot)).filter((file) => file.endsWith('.json'));
const resultFiles = (await safeReadDir(resultRoot)).filter((file) => file.endsWith('.json'));

const cases = await Promise.all(
  caseFiles.map(async (file) => ({
    file,
    data: JSON.parse(await readFile(path.join(benchmarkRoot, file), 'utf-8')),
  }))
);

const results = await Promise.all(
  resultFiles.map(async (file) => ({
    file,
    data: JSON.parse(await readFile(path.join(resultRoot, file), 'utf-8')),
  }))
);

const resultByCaseId = new Map(results.map((item) => [item.data.caseId, item.data]));

let totalScore = 0;
let totalWeight = 0;
let completed = 0;

for (const benchmarkCase of cases) {
  const score = calculateScore(benchmarkCase.data, resultByCaseId.get(benchmarkCase.data.id));
  totalScore += score.weightedScore;
  totalWeight += score.totalWeight;
  if (score.resultFound) {
    completed++;
  }

  console.log(
    `${benchmarkCase.data.id}: ${score.resultFound ? `${score.percent.toFixed(1)}%` : 'missing result'}`
  );
}

const summary = totalWeight === 0 ? 0 : (totalScore / totalWeight) * 100;
console.log(`\nBenchmarks: ${cases.length}`);
console.log(`Results found: ${completed}`);
console.log(`Weighted score: ${summary.toFixed(1)}%`);

function calculateScore(benchmarkCase, result) {
  const totalWeight = (benchmarkCase.scoreDimensions || []).reduce(
    (sum, dimension) => sum + Number(dimension.weight || 0),
    0
  );

  if (!result) {
    return {
      resultFound: false,
      weightedScore: 0,
      totalWeight,
      percent: 0,
    };
  }

  const weightedScore = (benchmarkCase.scoreDimensions || []).reduce((sum, dimension) => {
    const raw = Number(result.scores?.[dimension.id] || 0);
    return sum + raw * Number(dimension.weight || 0);
  }, 0);

  return {
    resultFound: true,
    weightedScore,
    totalWeight,
    percent: totalWeight === 0 ? 0 : (weightedScore / totalWeight) * 100,
  };
}

async function safeReadDir(targetDir) {
  try {
    return await readdir(targetDir);
  } catch {
    return [];
  }
}
