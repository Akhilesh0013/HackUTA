import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths as getPaths, ROOT } from '../src/config.mjs';

/** Fresh sandbox with a copy of guide/ and data/manuals/. */
export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-test-'));
  fs.cpSync(path.join(ROOT, 'guide'), path.join(dir, 'guide'), {
    recursive: true,
    filter: (src) => !/versions|CHANGELOG|GUIDE\.proposed/.test(src),
  });
  fs.cpSync(path.join(ROOT, 'data', 'manuals'), path.join(dir, 'data', 'manuals'), { recursive: true });
  // Reset to the seed knowledge so tests don't depend on curated state.
  const k = JSON.parse(fs.readFileSync(path.join(dir, 'guide', 'knowledge.json'), 'utf8'));
  k.meta = { version: 1, last_curated: '2026-11-14', sessions_included: 0, last_batch: 0 };
  k.entries = k.entries.filter((e) => e.source === 'seed');
  fs.writeFileSync(path.join(dir, 'guide', 'knowledge.json'), JSON.stringify(k, null, 2));
  return getPaths(dir);
}
