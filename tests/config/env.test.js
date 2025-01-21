import { describe, it, expect } from 'vitest';
import { loadConfig, describeConfig, environmentSchema } from '../../src/config/env.js';
import { ValidationError } from '../../src/lib/errors.js';

const base = {
  NODE_ENV: 'test',
  BURDENLINE_JWT_SECRET: 'a'.repeat(40),
};

describe('loadConfig', () => {
  it('fills in defaults for everything optional', () => {
    const config = loadConfig(base);
    expect(config.http.port).toBe(8080);
    expect(config.http.host).toBe('127.0.0.1');
    expect(config.database.file).toBe('data/burdenline.db');
    expect(config.database.walMode).toBe(true);
    expect(config.logging.level).toBe('info');
    expect(config.site.zone).toBe('Europe/Dublin');
  });

  it('coerces the numbers that arrive as strings', () => {
    const config = loadConfig({ ...base, BURDENLINE_PORT: '9100' });
    expect(config.http.port).toBe(9100);
  });

  it('reads the several spellings of a boolean', () => {
    expect(loadConfig({ ...base, BURDENLINE_DB_WAL: 'no' }).database.walMode).toBe(false);
    expect(loadConfig({ ...base, BURDENLINE_DB_WAL: '0' }).database.walMode).toBe(false);
    expect(loadConfig({ ...base, BURDENLINE_DB_WAL: 'yes' }).database.walMode).toBe(true);
  });

  it('freezes what it hands back', () => {
    const config = loadConfig(base);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it('rejects a port outside the range', () => {
    expect(() => loadConfig({ ...base, BURDENLINE_PORT: '70000' })).toThrow(ValidationError);
  });

  it('rejects an unknown log level and names the setting', () => {
    try {
      loadConfig({ ...base, BURDENLINE_LOG_LEVEL: 'chatty' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.issues.map((issue) => issue.path)).toContain('BURDENLINE_LOG_LEVEL');
    }
  });

  it('rejects a short signing secret', () => {
    expect(() => loadConfig({ ...base, BURDENLINE_JWT_SECRET: 'short' })).toThrow(ValidationError);
  });
});

describe('the production guards', () => {
  it('invents a development secret and says so', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.auth.jwtSecret).toContain('development-only');
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('BURDENLINE_JWT_SECRET');
  });

  it('refuses to start production without a secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ValidationError);
  });

  it('refuses an in memory database in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        BURDENLINE_JWT_SECRET: 'b'.repeat(40),
        BURDENLINE_DB: ':memory:',
      }),
    ).toThrow(/not usable/);
  });

  it('allows an in memory database anywhere else', () => {
    const config = loadConfig({ ...base, BURDENLINE_DB: ':memory:' });
    expect(config.database.file).toBe(':memory:');
    expect(config.isTest).toBe(true);
    expect(config.isProduction).toBe(false);
  });
});

describe('describeConfig', () => {
  it('leaves the signing secret out', () => {
    const described = describeConfig(loadConfig(base));
    expect(JSON.stringify(described)).not.toContain('aaaa');
    expect(described).not.toHaveProperty('jwtSecret');
    expect(described.env).toBe('test');
  });
});

describe('environmentSchema', () => {
  it('is exported so the deploy check can list the settings', () => {
    expect(Object.keys(environmentSchema.shape)).toContain('BURDENLINE_DB');
    expect(Object.keys(environmentSchema.shape).length).toBeGreaterThan(10);
  });
});
