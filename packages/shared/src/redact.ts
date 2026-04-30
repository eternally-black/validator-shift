/**
 * Threshold above which a contiguous run of base58/base64-ish chars is
 * treated as a likely secret regardless of context. Solana base58 pubkeys
 * are 32–44 chars; secret keys serialize to 64–88 chars. Picking 40 catches
 * keypair strings without false-positiving on session codes (6 chars) or
 * SHA-256 hex (64 chars but distinct charset — handled separately).
 */
const LONG_TOKEN_THRESHOLD = 40

/**
 * Layered redaction. Runs three independent passes — any one of them
 * could miss in isolation, but a leak survives only if ALL miss. Used
 * by both the agent CLI (terminal output, agent:log payloads) and the
 * hub (re-redacting agent-supplied messages before broadcasting — a
 * malicious agent should never leak secrets through the log channel).
 *
 * Pass 1: 64-byte JSON arrays (Solana keypair file format on disk).
 * Pass 2: long contiguous base64 / encrypted-payload runs.
 * Pass 3 (catch-all): any contiguous run of base58/base64 chars ≥40
 *   chars long. Catches keypair strings embedded mid-message, in
 *   stack traces, in JSON dumps from third-party errors. Even if the
 *   first two passes are bypassed (e.g. by re-encoding the keypair
 *   in a way that defeats the regexes), the length-based detector
 *   still catches the suspicious token.
 *
 * The cost: very rarely a benign 40+ alphanumeric token is replaced.
 * In our domain (Solana validator operator output) this is acceptable
 * — false positives are recoverable, false negatives leak keys.
 */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text
    .replace(/\[(\s*\d+\s*,\s*){63,}\s*\d+\s*\]/g, '[REDACTED:secret-bytes]')
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, (m) => `[REDACTED:base64:${m.length}]`)
    .replace(
      new RegExp(`[A-Za-z0-9+/=]{${LONG_TOKEN_THRESHOLD},}`, 'g'),
      (m) => `[REDACTED:long-token:${m.length}]`,
    )
}

/**
 * Returns true if `text` contains any contiguous run of ≥40
 * base58/base64-ish chars. Exported so callers can choose to outright
 * REJECT a message rather than redact it (used in adversarial-test
 * paths and in the agent's error-construction sanitizer).
 */
export function hasLongToken(text: string): boolean {
  if (!text) return false
  return new RegExp(`[A-Za-z0-9+/=]{${LONG_TOKEN_THRESHOLD},}`).test(text)
}

/**
 * Sanitize an error-message string for emission as a log event:
 *   - take only the first line (drop multi-line stack traces),
 *   - cap at 200 chars,
 *   - if a long-token run is still present, replace the whole message
 *     with a placeholder rather than risk partial leak.
 *
 * The whole-message replacement on long-token detection is deliberate:
 * an attacker who controls a thrown error's `.message` could craft it
 * to confuse the redactor (Unicode normalization, alternative encodings).
 * Refusing to log a suspicious message is safer than partial redaction.
 */
export function sanitizeErrorMessage(raw: string): string {
  if (!raw) return ''
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? ''
  const truncated = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
  if (hasLongToken(truncated)) {
    return '[REDACTED: error message contained long token]'
  }
  return truncated
}

/**
 * Validates that a session code is exactly 6 chars of [A-Z0-9].
 * Used by the WS layer to reject malformed `:code` path segments before any
 * DB lookup, so that adversarial path components can't reach query layers.
 */
export const SESSION_CODE_RE = /^[A-Z0-9]{6}$/

export function isValidSessionCode(s: string): boolean {
  return SESSION_CODE_RE.test(s)
}
