// npm run curate [-- --force] [--offline] [--allow-no-classifier]
import { paths as getPaths } from '../config.mjs';
import { MODEL_CHAINS, getGemini } from '../gemini.mjs';
import { runCuration } from '../curation/pipeline.mjs';

const args = new Set(process.argv.slice(2));
const offline = args.has('--offline');
const gemini = offline ? null : await getGemini();
if (gemini) console.log(`Proposer: ${MODEL_CHAINS.fast.join(' → ')}
Safety:   ${MODEL_CHAINS.strong.join(' → ')}`);
if (!gemini && !offline) console.log('No GEMINI_API_KEY: using the offline proposer.');

const res = await runCuration({
  paths: getPaths(),
  gemini,
  force: args.has('--force'),
  offline,
  allowNoClassifier: args.has('--allow-no-classifier'),
});

if (res.skipped) {
  console.log(res.reason);
} else {
  console.log(res.report);
  console.log(`Artifacts: ${res.dir}`);
}
