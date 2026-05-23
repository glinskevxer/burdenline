/**
 * Turning a thrown error into a response.
 *
 * One handler, and it is the only place in the codebase that knows about status
 * codes. Anything the domain threw carries its own; anything else is a five
 * hundred with its message dropped, because the message of an unexpected error
 * is as likely to contain a file path or a query as anything useful to a caller.
 *
 * Every error response carries the request id. It is the only thing that lets
 * somebody on the phone be matched to a line in the log.
 */

import { isAppError, toProblem, ValidationError, AppError } from '../../lib/errors.js';

/** What each of fastify's own refusals means, in words a caller can act on. */
const FRAMEWORK_MESSAGES = Object.freeze({
  FST_ERR_CTP_BODY_TOO_LARGE: 'the request body is larger than this route accepts',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'that content type is not served here',
  FST_ERR_CTP_INVALID_JSON_BODY: 'the request body is not valid json',
  FST_ERR_VALIDATION: 'the request did not validate',
});

const FRAMEWORK_CODES = Object.freeze({
  FST_ERR_CTP_BODY_TOO_LARGE: 'body_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_INVALID_JSON_BODY: 'malformed_json',
});

export function errorHandler(logger) {
  return function handleError(error, request, reply) {
    const requestId = request.id;
    const problem = toProblem(normalise(error), { instance: request.url });
    const status = problem.status;

    if (status >= 500) {
      logger.error(
        { err: error, requestId, url: request.url, method: request.method },
        'request failed',
      );
    } else {
      logger.info({ code: problem.title, requestId, url: request.url, status }, 'request refused');
    }

    reply
      .code(status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send({ ...problem, requestId });
  };
}

/** Fastify's own validation and parsing failures become domain errors first. */
export function normalise(error) {
  if (isAppError(error)) {
    return error;
  }
  if (error?.validation) {
    return new ValidationError(
      'the request did not validate',
      error.validation.map((issue) => ({
        path: (issue.instancePath ?? '').replace(/^\//, '') || issue.params?.missingProperty || '',
        message: issue.message,
        kind: issue.keyword,
      })),
    );
  }
  if (error?.statusCode === 400 && error?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
    return new ValidationError('the request body is empty', [
      { path: 'body', message: 'expected a json body', kind: 'missing' },
    ]);
  }
  if (error?.statusCode === 404) {
    return new ValidationError('there is nothing at that path', [
      { path: 'url', message: 'unknown route', kind: 'missing' },
    ]);
  }
  // Fastify raises its own errors for a body that is too large, one that does
  // not parse and a content type nobody serves. They carry a status and dropping
  // it turned every one of them into a five hundred, which reads to a caller as
  // the server being broken rather than the request being wrong.
  if (typeof error?.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
    return new AppError(FRAMEWORK_MESSAGES[error.code] ?? 'the request could not be read', {
      code: FRAMEWORK_CODES[error.code] ?? 'bad_request',
      status: error.statusCode,
    });
  }
  return error;
}

export function notFoundHandler() {
  return function handleNotFound(request, reply) {
    reply
      .code(404)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send({
        type: 'https://burdenline.invalid/problems/not_found',
        title: 'not found',
        status: 404,
        detail: `nothing is served at ${request.method} ${request.url}`,
        instance: request.url,
        requestId: request.id,
      });
  };
}
