// Error codes every harness endpoint answers with. A code names what the peer can act on; the
// message says the rest for a human.

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "node_offline",
  "version_mismatch",
  "session_locked",
  "invalid_record",
  "agent_failed",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ProtocolError = { code: ErrorCode; message: string };

export function protocolError(code: ErrorCode, message: string): ProtocolError {
  return { code, message };
}

/** An Error carrying a protocol code, thrown inside endpoints and turned into a response. */
export class HarnessError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof HarnessError) {
    return { code: error.code, message: error.message };
  } else if (error instanceof Error) {
    return { code: "internal", message: error.message };
  } else {
    return { code: "internal", message: String(error) };
  }
}
