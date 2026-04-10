/**
 * Typed error taxonomy for the audit feature.
 *
 * AuditError wraps every expected failure mode with a discriminated `code`
 * and a human-readable `hint`. The CLI's top-level handler formats these
 * consistently so users know exactly what went wrong and what to do.
 * Unknown errors still bubble up as plain stack traces so bugs stay visible.
 */

export type AuditErrorCode =
  | 'E_DRIVER_NOT_READY'    // WDA/maestro/xctest failed to start or crashed
  | 'E_APP_NOT_INSTALLED'   // bundleId doesn't exist on device
  | 'E_MODEL_INCOMPATIBLE'  // 3 consecutive NoObjectGeneratedError
  | 'E_NETWORK_TIMEOUT'     // single AI call exceeded hard per-step timeout
  | 'E_DEVICE_LOCKED'       // screenshots failing but driver alive
  | 'E_APP_CRASHED'         // bundle disappeared from foreground
  | 'E_BUDGET_EXCEEDED'     // token budget hit before max-steps
  | 'E_USER_ABORTED'        // SIGINT during run
  | 'E_CONCURRENT_RUN';     // another audit holds the device lock

export class AuditError extends Error {
  readonly code: AuditErrorCode;
  readonly hint: string;

  constructor(code: AuditErrorCode, hint: string, options?: { cause?: unknown }) {
    super(`[${code}] ${hint}`);
    this.name = 'AuditError';
    this.code = code;
    this.hint = hint;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** Narrow unknown to AuditError without importing lib DOM globals. */
export function isAuditError(err: unknown): err is AuditError {
  return err instanceof AuditError;
}
