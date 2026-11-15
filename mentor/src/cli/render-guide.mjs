// Re-render Part D of GUIDE.md from knowledge.json (e.g. after a manual knowledge.json edit).
import fs from 'node:fs';
import { paths as getPaths } from '../config.mjs';
import { loadKnowledge, partDWordCount, readGuide, renderGuide } from '../knowledge.mjs';

const p = getPaths();
const k = loadKnowledge(p.knowledge);
fs.writeFileSync(p.guide, renderGuide(readGuide(p.guide), k), 'utf8');
console.log(`Rendered GUIDE.md v${k.meta.version}: ${k.entries.filter((e) => e.status !== 'deprecated').length} active entries, Part D ${partDWordCount(k)} words.`);
