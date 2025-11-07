/**
 * The command table.
 *
 * One place that knows every command, so `burdenline help` cannot drift from
 * what is actually there.
 */

import { databaseCommands } from './database.js';
import { reportingCommands } from './reporting.js';

export function buildCommands(dependencies) {
  return {
    ...databaseCommands(dependencies),
    ...reportingCommands(dependencies),
  };
}

export function commandNames(dependencies) {
  return Object.keys(buildCommands(dependencies)).sort();
}
