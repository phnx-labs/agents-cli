import { recordSubsystemError } from '../daemon-health.js';

const [subsystem, countRaw] = process.argv.slice(2);
const count = Number(countRaw);
if (!subsystem || !Number.isInteger(count) || count < 1) process.exit(2);

for (let i = 0; i < count; i++) {
  recordSubsystemError(subsystem, `${process.pid}:${i}`);
}
