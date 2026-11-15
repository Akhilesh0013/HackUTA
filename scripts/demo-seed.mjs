// Build demo history in a separate folder (default ./demo-data) so the dashboard has a story to show:
// 60 calls on v1 → curation learns and blocks → v2 published → a bad batch → automatic rollback to v3.
// The repo's own guide/ and data/ are never touched.
//   npm run demo:seed            then   npm run demo   (server on that folder)
//   npm run demo:seed -- --keep-v2   stop after publishing v2 (no bad batch, no rollback)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, paths as getPaths } from '../src/config.mjs';
import { runCuration } from '../src/curation/pipeline.mjs';
import { monitor, publishBatch } from '../src/curation/publish.mjs';
import { loadKnowledge, saveKnowledge, renderGuide, readGuide } from '../src/knowledge.mjs';
import { simulate } from '../src/sim.mjs';

const dir = path.resolve(process.env.DEMO_ROOT || path.join(ROOT, 'demo-data'));
if (dir === ROOT) throw new Error('DEMO_ROOT must not be the project folder');
const keepV2 = process.argv.includes('--keep-v2');

fs.rmSync(dir, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'guide'), path.join(dir, 'guide'), {
  recursive: true,
  filter: (src) => !/versions|CHANGELOG|GUIDE\.proposed/.test(src),
});
fs.cpSync(path.join(ROOT, 'data', 'manuals'), path.join(dir, 'data', 'manuals'), { recursive: true });
const paths = getPaths(dir);

// Start from the seed playbook (v1), whatever the repo's guide has been curated to.
const k = loadKnowledge(paths.knowledge);
k.meta = { version: 1, last_curated: k.meta.last_curated, sessions_included: 0, last_batch: 0 };
k.entries = k.entries.filter((e) => e.source === 'seed');
saveKnowledge(paths.knowledge, k);
fs.writeFileSync(paths.guide, renderGuide(readGuide(paths.guide), k));

const quiet = () => {};
const first = simulate({ paths, guideVersion: 1, sessions: 60, seed: 42 });
const cur = await runCuration({ paths, allowNoClassifier: true, log: quiet });
publishBatch({ paths, batch: 1 });
console.log(`v1: ${JSON.stringify(first)} calls · curation learned ${cur.applied.length}, blocked ${cur.rejected.length} · published v2`);
if (!keepV2) {
  simulate({ paths, guideVersion: 2, sessions: 40, quality: 0.3, seed: 7, prefix: 'v2' });
  const m = monitor({ paths });
  console.log(`v2: 40 weaker calls · monitor: ${m.action}${m.new_version ? ` → v${m.new_version}` : ''}`);
}
console.log(`Demo data in ${dir}. Start with: npm run demo`);
