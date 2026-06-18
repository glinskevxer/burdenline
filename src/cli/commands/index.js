/**
 * The command table.
 *
 * One place that knows every command, so `burdenline help` cannot drift from
 * what is actually there.
 */

import { databaseCommands } from './database.js';
import { reportingCommands } from './reporting.js';
import { jobCommands } from './jobs.js';
import { supplyCommands } from './supply.js';
import { accessCommands } from './access.js';

export function buildCommands(dependencies) {
  return {
    ...databaseCommands(dependencies),
    ...reportingCommands(dependencies),
    ...jobCommands(dependencies),
    ...supplyCommands(dependencies),
    ...accessCommands(dependencies),
  };
}

export function commandNames(dependencies) {
  return Object.keys(buildCommands(dependencies)).sort();
}
