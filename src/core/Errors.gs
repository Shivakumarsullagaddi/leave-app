/**
 * Errors.gs — one error type for problems the user can understand and fix.
 * Anything else is treated as an unexpected failure by the API layer.
 */
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

const Errors = {
  invalid:      (msg) => new AppError('INVALID', msg),
  notFound:     (what) => new AppError('NOT_FOUND', what + ' was not found.'),
  forbidden:    (msg) => new AppError('FORBIDDEN', msg),
  conflict:     (msg) => new AppError('CONFLICT', msg),
  notRegistered:(email) => new AppError('NOT_REGISTERED',
    (email ? email + ' is' : 'Your account is') + ' not in the Leave Desk directory. Ask the admin to add you.'),
  setup:        (msg) => new AppError('SETUP', msg),
  unauthenticated: () => new AppError('UNAUTHENTICATED', 'Your session has ended. Please sign in again.'),
};
