/**
 * The command line.
 *
 * There is no argument parsing library here on purpose. The tool has a dozen
 * commands, every one of them takes named options, and the whole grammar is
 * `burdenline <command> --name value --flag`. A library for that is more code to
 * read than the parser, and it would still need this layer to turn a domain
 * error into an exit code.
 *
 * Exit codes matter because these commands run from cron: 0 is fine, 1 is a
 * failure the caller can act on, 2 is being asked for something that does not
 * exist, and 3 is a refusal by a rule, which is not the same as a failure.
 */

import { isAppError } from '../lib/errors.js';

export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  notFound: 2,
  refused: 3,
  usage: 64,
});

export function parseArgv(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name.includes('=')) {
      const [key, ...value] = name.split('=');
      options[camel(key)] = value.join('=');
      continue;
    }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[camel(name)] = true;
      continue;
    }
    options[camel(name)] = next;
    index += 1;
  }
  return { command, options, positional };
}

export function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_match, character) => character.toUpperCase());
}

export function number(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new UsageError(`--${name} has to be a number`);
  }
  return parsed;
}

export function required(options, names) {
  const missing = names.filter((name) => options[name] === undefined);
  if (missing.length > 0) {
    throw new UsageError(`missing ${missing.map((name) => `--${name}`).join(' and ')}`);
  }
  return options;
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function buildHelp(commands) {
  const width = Math.max(...Object.keys(commands).map((name) => name.length));
  const lines = ['burdenline <command> [options]', '', 'commands:'];
  for (const [name, command] of Object.entries(commands)) {
    lines.push(`  ${name.padEnd(width)}  ${command.summary}`);
  }
  lines.push('', 'run a command with --help for its own options');
  return lines.join('\n');
}

export function commandHelp(name, command) {
  const lines = [`burdenline ${name} ${command.usage ?? ''}`.trim(), '', command.summary];
  if (command.options) {
    lines.push('', 'options:');
    const width = Math.max(...Object.keys(command.options).map((option) => option.length));
    for (const [option, description] of Object.entries(command.options)) {
      lines.push(`  --${option.padEnd(width)}  ${description}`);
    }
  }
  return lines.join('\n');
}

/** Run one command and turn whatever happened into an exit code. */
export async function run(commands, argv, io = console) {
  const { command, options, positional } = parseArgv(argv);
  if (!command || command === 'help' || options.help === true) {
    const named = command === 'help' ? positional[0] : command;
    if (named && commands[named]) {
      io.log(commandHelp(named, commands[named]));
      return EXIT.ok;
    }
    io.log(buildHelp(commands));
    return command && command !== 'help' ? EXIT.usage : EXIT.ok;
  }
  const found = commands[command];
  if (!found) {
    io.error(`there is no command called ${command}`);
    io.error(buildHelp(commands));
    return EXIT.usage;
  }
  try {
    const result = await found.run({ options, positional, io });
    return result ?? EXIT.ok;
  } catch (error) {
    return report(error, io);
  }
}

export function report(error, io) {
  if (error instanceof UsageError) {
    io.error(error.message);
    return EXIT.usage;
  }
  if (isAppError(error)) {
    io.error(`${error.code}: ${error.message}`);
    for (const issue of error.details?.issues ?? []) {
      io.error(`  ${issue.path}: ${issue.message}`);
    }
    for (const violation of error.details?.violations ?? []) {
      io.error(`  ${violation.rule}: ${violation.message}`);
    }
    if (error.status === 404) {
      return EXIT.notFound;
    }
    return error.status === 422 || error.status === 409 ? EXIT.refused : EXIT.failed;
  }
  io.error(error.stack ?? String(error));
  return EXIT.failed;
}
