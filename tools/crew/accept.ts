/**
 * The acceptance gate as a crew worker runs it: tools/mutation/accept.ts on one task, with credentials scrubbed from
 * the environment and, when CREW_ACCEPT_PREFIX is set, inside a namespace with no network.
 *   node tools/crew/accept.ts <task-file>
 */
import { runAcceptance } from './lib.ts';

const task = process.argv[2];
if (!task || process.argv.length > 3) {
  console.error('usage: node tools/crew/accept.ts <task-file>');
  process.exit(2);
}
const r = runAcceptance(task);
process.stdout.write(r.output.endsWith('\n') ? r.output : `${r.output}\n`);
process.exit(r.ok ? 0 : 1);
