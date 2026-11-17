const knownCodes = new Set(['STANDALONE_VERSION_INCOMPATIBLE', 'STANDALONE_RUNTIME_CHANGED',
  'MAINNET_RUNTIME_VERSION_MISMATCH', 'MAINNET_BACKEND_UNAVAILABLE', 'MAINNET_BACKEND_NOT_READY',
  'MAINNET_BACKEND_AUTH_FAILED', 'MAINNET_START_TIMEOUT', 'MAINNET_START_FAILED']);

/** Child-process messages can contain command arguments and private output.
 * Forward only a complete allowlisted stderr line, never the execFile message. */
export function localToolErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'LOCAL_TOOL_UNAVAILABLE';
  if (/^LOCAL_[A-Z_]+$/.test(error.message) || knownCodes.has(error.message)) return error.message;
  if ('stderr' in error && typeof error.stderr === 'string') {
    const candidate = error.stderr.trim();
    if (knownCodes.has(candidate)) return candidate;
  }
  return 'LOCAL_TOOL_UNAVAILABLE';
}
