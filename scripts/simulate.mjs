// npm run simulate [-- --sessions 60] [--seed 42] [--no-attacks] [--no-noise] [--quality 0.5]
import { paths as getPaths } from '../src/config.mjs';
import { loadKnowledge } from '../src/knowledge.mjs';
import { simulate } from '../src/sim.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const p = getPaths();
const guideVersion = loadKnowledge(p.knowledge).meta.version;
const counts = simulate({
  paths: p,
  guideVersion,
  sessions: opt('sessions', 60),
  seed: opt('seed', Date.now() % 100000),
  quality: opt('quality', 1),
  attacks: !argv.includes('--no-attacks'),
  noise: !argv.includes('--no-noise'),
});
console.log(`Simulated against guide v${guideVersion}:`, counts, `→ ${p.observations}`);
