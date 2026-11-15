// npm run publish-guide -- --approve <batch>
import { paths as getPaths } from '../config.mjs';
import { publishBatch } from '../curation/publish.mjs';

const argv = process.argv.slice(2);
const i = argv.indexOf('--approve');
const batch = i >= 0 ? Number(argv[i + 1]) : NaN;
if (!Number.isInteger(batch)) {
  console.error('Usage: npm run publish-guide -- --approve <batch number>\nRead data/curation/batch-<n>/report.md first.');
  process.exit(1);
}
try {
  const r = publishBatch({ paths: getPaths(), batch });
  console.log(`Published batch #${batch}: GUIDE.md v${r.from} → v${r.to}. Old version saved in guide/versions/.`);
} catch (err) {
  console.error(`Publish refused: ${err.message}`);
  process.exit(1);
}
