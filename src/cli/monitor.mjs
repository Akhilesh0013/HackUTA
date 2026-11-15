// npm run monitor [-- --dry-run]
import { paths as getPaths } from '../config.mjs';
import { monitor } from '../curation/publish.mjs';

const r = monitor({ paths: getPaths(), dryRun: process.argv.includes('--dry-run') });
console.log(JSON.stringify(r, null, 2));
