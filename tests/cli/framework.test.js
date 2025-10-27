import { describe, it, expect } from 'vitest';
import {
  parseArgv,
  camel,
  number,
  required,
  UsageError,
  buildHelp,
  commandHelp,
  run,
  report,
  EXIT,
} from '../../src/cli/framework.js';
import { NotFoundError, RuleViolationError, ValidationError } from '../../src/lib/errors.js';

function collector() {
  const out = [];
  const err = [];
  return {
    io: { log: (line) => out.push(String(line)), error: (line) => err.push(String(line)) },
    out,
    err,
  };
}

const commands = {
  migrate: { summary: 'apply outstanding migrations', run: async () => EXIT.ok },
  seed: {
    summary: 'load a demonstration site',
    usage: '--site MDW',
    options: { site: 'the site code to create' },
    run: async ({ io }) => {
      io.log('seeded');
      return EXIT.ok;
    },
  },
};

describe('parseArgv', () => {
  it('reads the command and named options', () => {
    expect(parseArgv(['seed', '--site', 'MDW'])).toEqual({
      command: 'seed',
      options: { site: 'MDW' },
      positional: [],
    });
  });

  it('reads an option written with an equals sign', () => {
    expect(parseArgv(['seed', '--site=MDW']).options).toEqual({ site: 'MDW' });
  });

  it('reads a bare option as a flag', () => {
    expect(parseArgv(['seed', '--dry-run']).options).toEqual({ dryRun: true });
  });

  it('reads a flag followed by another option as a flag', () => {
    expect(parseArgv(['seed', '--force', '--site', 'MDW']).options).toEqual({
      force: true,
      site: 'MDW',
    });
  });

  it('keeps positional arguments', () => {
    expect(parseArgv(['report', 'blast_1', '--format', 'csv']).positional).toEqual(['blast_1']);
  });

  it('turns a dashed option into a camel case name', () => {
    expect(camel('powder-factor')).toBe('powderFactor');
    expect(parseArgv(['x', '--powder-factor', '0.55']).options.powderFactor).toBe('0.55');
  });
});

describe('option helpers', () => {
  it('reads a number and refuses text', () => {
    expect(number('0.55', 'powderFactor')).toBe(0.55);
    expect(number(undefined, 'powderFactor')).toBe(undefined);
    expect(() => number('lots', 'powderFactor')).toThrow(UsageError);
  });

  it('names every missing option at once', () => {
    expect(() => required({ site: 'MDW' }, ['site', 'bench', 'reference'])).toThrow(
      /--bench and --reference/,
    );
  });
});

describe('help', () => {
  it('lists the commands', () => {
    const help = buildHelp(commands);
    expect(help).toContain('migrate');
    expect(help).toContain('apply outstanding migrations');
  });

  it('describes one command and its options', () => {
    const help = commandHelp('seed', commands.seed);
    expect(help).toContain('burdenline seed --site MDW');
    expect(help).toContain('--site');
  });
});

describe('run', () => {
  it('runs the command it was asked for', async () => {
    const { io, out } = collector();
    expect(await run(commands, ['seed'], io)).toBe(EXIT.ok);
    expect(out).toContain('seeded');
  });

  it('prints the help with no command at all', async () => {
    const { io, out } = collector();
    expect(await run(commands, [], io)).toBe(EXIT.ok);
    expect(out[0]).toContain('burdenline <command>');
  });

  it('prints the help for one command', async () => {
    const { io, out } = collector();
    expect(await run(commands, ['seed', '--help'], io)).toBe(EXIT.ok);
    expect(out[0]).toContain('--site');
  });

  it('complains about a command that is not there', async () => {
    const { io, err } = collector();
    expect(await run(commands, ['detonate'], io)).toBe(EXIT.usage);
    expect(err[0]).toContain('no command called detonate');
  });
});

describe('report', () => {
  it('turns a missing record into the not found code', () => {
    const { io, err } = collector();
    expect(report(new NotFoundError('blast', 'blast_1'), io)).toBe(EXIT.notFound);
    expect(err[0]).toContain('not_found');
  });

  it('turns a rule breach into the refused code and lists the rules', () => {
    const { io, err } = collector();
    const error = RuleViolationError.of([{ rule: 'stemming.minimum', message: 'too short' }]);
    expect(report(error, io)).toBe(EXIT.refused);
    expect(err.join('\n')).toContain('stemming.minimum');
  });

  it('lists the issues of a validation failure', () => {
    const { io, err } = collector();
    const error = new ValidationError('bad', [{ path: 'depth', message: 'too small' }]);
    expect(report(error, io)).toBe(EXIT.refused);
    expect(err.join('\n')).toContain('depth');
  });

  it('turns a usage mistake into the usage code', () => {
    const { io, err } = collector();
    expect(report(new UsageError('missing --site'), io)).toBe(EXIT.usage);
    expect(err[0]).toBe('missing --site');
  });

  it('prints the stack of anything it does not recognise', () => {
    const { io, err } = collector();
    expect(report(new Error('boom'), io)).toBe(EXIT.failed);
    expect(err[0]).toContain('boom');
  });
});
