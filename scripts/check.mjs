import { spawnSync } from 'node:child_process';

const suites = ['selftest', 'store-test', 'feature-check', 'feature-unit-test', 'pipeline-test',
  'attribution-test', 'economics-test', 'journey-analytics-test', 'portfolio-test',
  'diagnostics-test', 'decisions-test', 'revenue-coverage-test', 'brief-test', 'webhook-test', 'webhook-refresh-test', 'copilot-test'];
const failures = [];
for (const suite of suites) {
  const result = spawnSync(process.execPath, [`scripts/${suite}.mjs`], { stdio: 'inherit' });
  if (result.status !== 0 || result.error) failures.push(suite);
}
console.log(failures.length ? `Failed suites: ${failures.join(', ')}` : `All ${suites.length} suites passed.`);
process.exitCode = failures.length ? 1 : 0;
