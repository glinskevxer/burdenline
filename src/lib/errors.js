/**
 * Error types shared by the domain, the services and the HTTP layer.
 *
 * Domain code throws these and never touches a status code directly. The HTTP
 * error handler is the only thing that reads `status`, and the CLI reads `code`
 * to pick an exit code. A rule breach is a first class error because most of
 * what this system does is refuse to let a shot go ahead.
 */

export class AppError extends Error {
  constructor(message, { code = 'internal_error', status = 500, details = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = status < 500;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      details: this.details,
    };
  }
}

export class ValidationError extends AppError {
  constructor(message, issues = []) {
    super(message, { code: 'validation_failed', status: 422, details: { issues } });
    this.issues = issues;
  }

  static fromZod(error, message = 'the payload did not validate') {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      kind: issue.code,
    }));
    return new ValidationError(message, issues);
  }
}

export class NotFoundError extends AppError {
  constructor(kind, id) {
    super(`no ${kind} with id ${id}`, {
      code: 'not_found',
      status: 404,
      details: { kind, id },
    });
    this.kind = kind;
    this.id = id;
  }
}

export class ConflictError extends AppError {
  constructor(message, details = null) {
    super(message, { code: 'conflict', status: 409, details });
  }
}

export class StateError extends AppError {
  constructor(kind, from, action, allowed = []) {
    super(`a ${kind} in state ${from} cannot ${action}`, {
      code: 'invalid_state',
      status: 409,
      details: { kind, from, action, allowed },
    });
    this.from = from;
    this.action = action;
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'not permitted', details = null) {
    super(message, { code: 'forbidden', status: 403, details });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'not authenticated') {
    super(message, { code: 'unauthenticated', status: 401 });
  }
}

/**
 * Raised when a design, a load sheet or a firing gate breaks one or more of the
 * rules the site runs under. The violations travel with the error because the
 * caller almost always wants to show all of them at once, not the first.
 */
export class RuleViolationError extends AppError {
  constructor(message, violations = []) {
    super(message, {
      code: 'rule_violation',
      status: 422,
      details: { violations },
    });
    this.violations = violations;
  }

  get codes() {
    return this.violations.map((violation) => violation.rule);
  }

  static of(violations, message = 'the design breaks site rules') {
    return new RuleViolationError(message, violations);
  }
}

export function isAppError(value) {
  return value instanceof AppError;
}

/** RFC 7807 style body. Unknown errors never leak their message. */
export function toProblem(error, { instance = null } = {}) {
  if (isAppError(error)) {
    return {
      type: `https://burdenline.invalid/problems/${error.code}`,
      title: error.code.replace(/_/g, ' '),
      status: error.status,
      detail: error.message,
      instance,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    type: 'https://burdenline.invalid/problems/internal_error',
    title: 'internal error',
    status: 500,
    detail: 'the request could not be completed',
    instance,
  };
}
