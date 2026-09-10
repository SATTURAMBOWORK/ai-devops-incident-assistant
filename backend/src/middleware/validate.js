import { AppError } from './errorHandler.js';

// Runs a request schema from models/*.validation.js before the controller.
//
// Usage:  router.post('/', validate(createIncidentSchema), controller)
//
// Checks each part the schema describes (params, query, body). On failure it
// sends every problem at once as a 400, so the client can fix them all in one
// go instead of one per request.
//
// Parsed values go on `req.validated`, not back onto req.query / req.body:
// in Express 5 `req.query` is read-only, and the parsed values are better
// anyway - trimmed, with defaults applied and query strings turned into numbers.
export function validate(schemas) {
  return (req, res, next) => {
    const validated = {};
    const problems = [];

    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;

      const result = schemas[part].safeParse(req[part] ?? {});
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          // e.g. "metrics.cpuUsage: Too big: expected number to be <=100"
          const field = issue.path.length ? issue.path.join('.') : part;
          problems.push(`${field}: ${issue.message}`);
        }
      }
    }

    if (problems.length) {
      return next(new AppError(problems.join('; '), 400, 'VALIDATION_ERROR'));
    }

    req.validated = validated;
    next();
  };
}
