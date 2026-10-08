/**
 * Error taxonomy shared by domain, storage and services.
 *
 * Codes are stable strings so UI layers can map them to messages without
 * matching on human-readable text.
 */
export type AppErrorCode =
  | 'duplicate_book'
  | 'unsupported_format'
  | 'integrity_failure'
  | 'storage_unavailable'
  | 'not_found'
  | 'invalid_argument'
  | 'invalid_state';

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
  }
}

/** Thrown when imported bytes already exist in the library. */
export class DuplicateBookError extends AppError {
  readonly existingBookId: string;

  constructor(existingBookId: string, message = 'This file is already in the library.') {
    super('duplicate_book', message);
    this.name = 'DuplicateBookError';
    this.existingBookId = existingBookId;
  }
}

/** Thrown when content cannot be identified as a supported book format. */
export class UnsupportedFormatError extends AppError {
  constructor(message = 'The selected file is not a recognised book format.') {
    super('unsupported_format', message);
    this.name = 'UnsupportedFormatError';
  }
}

/** Thrown when stored bytes do not match their expected content hash. */
export class IntegrityError extends AppError {
  constructor(message = 'File integrity check failed.') {
    super('integrity_failure', message);
    this.name = 'IntegrityError';
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
