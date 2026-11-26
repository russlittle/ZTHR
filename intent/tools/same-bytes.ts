// The studio and the command line run one engine: rebuild a studio release from its saved state and compare.
import fs from 'node:fs';
import { prepare } from '../src/pipeline.ts';
import { release } from '../src/release.ts';
const st = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8'));
const p = prepare({ files: [{ path: st.path, text: st.words }], readings: st.readings, answers: st.answers });
const r = release(p, { revision: 1 });
const m = JSON.parse(r.files['manifest.json']!);
console.log('node:', m.package, ' studio:', st.releases[0].package, m.package === st.releases[0].package ? 'SAME' : 'DIFFERENT');
