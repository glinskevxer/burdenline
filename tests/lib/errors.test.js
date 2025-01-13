import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  StateError,
  AuthorizationError,
  AuthenticationError,
  RuleViolationError,
  isAppError,
  toProblem,
} from '../../src/lib/errors.js';

describe('AppError', () => {
  it('defaults to an internal server error that is not exposed', () => {
    const error = new AppError('something broke');
    expect(error.code).toBe('internal_error');
    expect(error.status).toBe(500);
    expect(error.expose).toBe(false);
    expect(error.name).toBe('AppError');
  });

  it('marks client errors as safe to show', () => {
    const error = new AppError('bad input', { status: 400, code: 'bad_request' });
    expect(error.expose).toBe(true);
  });

  it('keeps a cause', () => {
    const cause = new Error('disk full');
    const error = new AppError('write failed', { cause });
    expect(error.cause).toBe(cause);
  });

  it('serialises without the stack', () => {
    const error = new AppError('nope', { code: 'x', status: 400, details: { a: 1 } });
    expect(error.toJSON()).toEqual({
      name: 'AppError',
      code: 'x',
      status: 400,
      message: 'nope',
      details: { a: 1 },
    });
  });
});

describe('ValidationError', () => {
  it('carries the issues at 422', () => {
    const error = new ValidationError('bad', [{ path: 'depth', message: 'too small' }]);
    expect(error.status).toBe(422);
    expect(error.issues).toHaveLength(1);
  });

  it('flattens a zod error into paths and messages', () => {
    const schema = z.object({ depth: z.number().positive(), id: z.string() });
    const parsed = schema.safeParse({ depth: -1 });
    const error = ValidationError.fromZod(parsed.error);
    const paths = error.issues.map((issue) => issue.path).sort();
    expect(paths).toEqual(['depth', 'id']);
    expect(error.details.issues).toBe(error.issues);
  });
});

describe('the rest of the hierarchy', () => {
  it('names the missing thing', () => {
    const error = new NotFoundError('pattern', 'pat_9');
    expect(error.message).toBe('no pattern with id pat_9');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ kind: 'pattern', id: 'pat_9' });
  });

  it('reports a conflict', () => {
    expect(new ConflictError('already loaded').status).toBe(409);
  });

  it('reports an illegal transition with the moves that were allowed', () => {
    const error = new StateError('blast', 'fired', 'approve', ['designed', 'reviewed']);
    expect(error.message).toBe('a blast in state fired cannot approve');
    expect(error.details.allowed).toEqual(['designed', 'reviewed']);
  });

  it('separates authentication from authorisation', () => {
    expect(new AuthenticationError().status).toBe(401);
    expect(new AuthorizationError().status).toBe(403);
  });
});

describe('RuleViolationError', () => {
  const violations = [
    { rule: 'stemming.min', message: 'stemming below 20 diameters', holeId: 'h1' },
    { rule: 'mic.exceeded', message: 'window 3 over the allowance' },
  ];

  it('collects every violation rather than the first', () => {
    const error = RuleViolationError.of(violations);
    expect(error.violations).toHaveLength(2);
    expect(error.codes).toEqual(['stemming.min', 'mic.exceeded']);
    expect(error.status).toBe(422);
  });
});

describe('toProblem', () => {
  it('renders a known error with its details', () => {
    const problem = toProblem(new NotFoundError('hole', 'h4'), { instance: '/holes/h4' });
    expect(problem).toEqual({
      type: 'https://burdenline.invalid/problems/not_found',
      title: 'not found',
      status: 404,
      detail: 'no hole with id h4',
      instance: '/holes/h4',
      details: { kind: 'hole', id: 'h4' },
    });
  });

  it('hides the message of an error it does not own', () => {
    const problem = toProblem(new Error('connection string password leaked'));
    expect(problem.status).toBe(500);
    expect(problem.detail).toBe('the request could not be completed');
    expect(JSON.stringify(problem)).not.toContain('password');
  });

  it('knows its own errors', () => {
    expect(isAppError(new ConflictError('x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });
});
