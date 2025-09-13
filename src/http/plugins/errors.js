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

import { isAppError, toProblem, ValidationError } from '../../lib/errors.js';

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
