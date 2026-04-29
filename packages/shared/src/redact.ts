/**
 * Redact likely secret material from a string before logging or sending it
 * over the wire. Used by both the agent CLI (terminal output, agent:log
 * payloads) and the hub (re-redacting agent-supplied messages before
 * broadcasting to dashboards — defence in depth: a malicious agent should
 * never be able to leak secrets through the log channel).
 *
 * Targets:
 *   - 64-byte JSON arrays (Solana keypair format)
 *   - Long contiguous base64 blobs (encrypted payloads, raw secret keys)
 */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text
    .replace(/\[(\s*\d+\s*,\s*){63,}\s*\d+\s*\]/g, '[REDACTED:secret-bytes]')
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, (m) => `[REDACTED:base64:${m.length}]`)
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
