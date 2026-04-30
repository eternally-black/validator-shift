# Threat model

This document is a STRIDE-style breakdown of the threats ValidatorShift is designed to defend against, the cryptographic and procedural mitigations in place, and the residual risks that remain the operator's responsibility. It complements [docs/SECURITY.md](./SECURITY.md) (which describes the protocol primitives) and [docs/RECOVERY.md](./RECOVERY.md) (which describes operator recovery for migration failures).

## STRIDE matrix

| Category | Threat | Mitigation |
|---|---|---|
| **Spoofing** | A malicious Hub (or active network attacker) substitutes its own X25519 public key for one or both peers, completing two separate ECDH handshakes and decrypting all relayed traffic. | Each agent derives a Short Authentication String (SAS) from the X25519 shared secret and displays it in its terminal. The operator must visually compare both SAS strings before approving the migration. A MITM produces two different SAS values — one per substitute key — so the comparison detects the attack. SAS entropy is **≈19.93 bits** (6 decimal digits formatted `XXX-XXX`, 10⁶ values), exceeding the 20-bit baseline used by Signal / WhatsApp safety numbers. HKDF-SHA256 with the domain-separated `validator-shift-sas-v2` info tag produces the value deterministically on both sides. |
| **Tampering** | The Hub or a network attacker modifies an encrypted payload in transit (corrupting the tower file, swapping the keypair, or splicing in a different envelope). | Every payload is sealed with XChaCha20-Poly1305 AEAD. Any single-bit modification fails Poly1305 authentication and is rejected by the receiving agent. Additionally, the source attaches a SHA-256 hash of the underlying plaintext (tower bytes, raw secret-key bytes); the receiver re-computes after decryption and aborts on mismatch. The receiver writes the file with `O_CREAT 0o600`, calls `fsync`, then re-reads from disk and re-hashes — catching ledger-level corruption distinct from network tampering. |
| **Repudiation** | An agent (or operator) denies having executed a destructive step (e.g. "I never wiped the keypair"), making post-incident forensics impossible. | The Hub persists a structured audit log: every state transition, every `agent:step_complete` / `agent:step_failed` event, every SAS confirmation, every operator confirmation prompt response, with timestamps and session IDs in SQLite. Logs are emitted as structured events (JSON), not free-form strings. **Note: full structured-logging coverage is in progress** — some legacy log paths still emit free-form strings that are normalized before Hub broadcast but not yet schematized end-to-end. |
| **Information disclosure** | A passive observer (Hub operator with root, ISP-level network observer, compromised TLS terminator) attempts to read the validator's staked keypair as it passes through the relay. | End-to-end encryption: X25519 ECDH establishes a shared secret known only to the two agents. HKDF-SHA256 derives a session key from that shared secret with a domain-separated `info` label (`validator-shift-session-v1`). Payloads are sealed with XChaCha20-Poly1305 (24-byte random nonces, 16-byte Poly1305 tag) before leaving the source agent. The Hub's binary has no decryption primitive linked into it. The session key never leaves the agent process and is zeroized on exit. Even with a full Hub root compromise plus SQLite snapshot, the attacker recovers only ciphertext. |
| **Denial of service** | A malicious party stalls or crashes a migration — either to extort, to force the operator into an insecure manual fallback, or simply to degrade availability. | The session token is a 6-character nanoid checked against the SQLite session row using a constant-time comparison (`crypto.timingSafeEqual`) before any WebSocket traffic is accepted, preventing brute-force pairing. Per-IP rate limits on session creation cap blast radius. Lost connections during `MIGRATING` deterministically trigger rollback for safe failure modes (source disconnect before step 5) or surface a `critical_alert` for unsafe ones (target disconnect after step 5). The state machine refuses to re-issue `execute_step` on terminal states. **Availability itself is not a security guarantee** — a hostile Hub can refuse service, but cannot exfiltrate keys. |
| **Elevation of privilege** | The Hub (or an attacker who controls the Hub) tries to escalate from a coordination role into operating on validator state — e.g. by injecting a forged `hub:execute_step` for a step the agent has no business running, or by replaying a captured payload. | Agents only act on `hub:execute_step` while in `MIGRATING` stage and only for the current step number; out-of-order or duplicate step messages are dropped. Destructive steps (2, 6, 9) require an interactive operator confirmation in the agent's terminal — the Hub cannot satisfy this prompt. Encrypted payloads are bound to the session via the HKDF-derived session key; replays from a different session decrypt to garbage and are rejected. The agent never trusts Hub-supplied pubkeys for identity verification — it cross-checks `--identity-pubkey` against the running validator's `getIdentity` JSON-RPC response during preflight. |

## What the Hub sees

- **Session pairing metadata.** The 6-character session code, agent role labels (`source` / `target`), connection timestamps, source IP addresses, and the WebSocket lifecycle for each connection.
- **Agent X25519 public keys.** Both agents send their ephemeral pairing pubkeys via `agent:hello`. The Hub stores and forwards them so each agent learns the other's pubkey.
- **Encrypted ciphertext bytes.** Tower file payloads, identity keypair payloads, and `voting_confirmed` envelopes — all sealed with XChaCha20-Poly1305 before they reach the Hub. The Hub forwards them byte-for-byte and discards them after delivery.
- **SHA-256 hashes** of plaintext payloads, attached for receiver-side integrity verification. The hash does not leak the underlying secret (256-bit preimage resistance), but does leak whether two sessions transferred the same keypair (a non-issue for one-shot migrations).
- **State transitions.** `IDLE → PAIRING → PREFLIGHT → AWAITING_WINDOW → MIGRATING → COMPLETE` (or `ROLLBACK → FAILED`), each with timestamps and step numbers.
- **Audit log events.** SAS confirmations from each agent, step completions and failures, preflight check pass/fail, operator aborts.
- **Structured agent logs.** Both agents emit `agent:log` events that the Hub passes through `redactSecrets` before broadcasting to dashboards. Log levels are `info` / `warn` / `error`.

## What the Hub does NOT see

- The validator identity keypair, in plaintext or any reversible form. Not in transit, not in memory, not in SQLite.
- The X25519 ephemeral private keys. Each agent generates its own and never transmits it; only the public key crosses the Hub.
- The XChaCha20-Poly1305 session key derived locally by each agent via HKDF over the X25519 shared secret. The Hub cannot reconstruct the shared secret without one of the private keys.
- The tower file contents.
- The unstaked replacement keypair generated on source for step 2.
- Operator credentials of any kind. ValidatorShift never asks for SSH keys, Solana wallet seeds, or hub passwords; the only operator-side secret is the keypair file path, which never leaves the agent host.
- The plaintext of `voting_confirmed` envelopes — even those, despite carrying no secret material, are encrypted with the same session key for protocol uniformity.

## Why a Hub at all? Why not pure peer-to-peer?

Validator operators run on tightly firewalled hosts. In production, the only inbound ports a validator typically exposes are the Solana gossip port (UDP, 8001) and the JSON-RPC port (TCP, 8899) — and many operators bind RPC to `localhost` only. Asking an operator to open a fresh inbound TCP port for a one-shot migration tool is operationally hostile: it requires firewall changes, possibly cloud security-group edits, possibly NAT hole-punching coordination with whichever colocation facility the validator lives in. For a migration that should take minutes, the firewall paperwork alone might take hours.

A relay Hub solves this by inverting the connection direction: both agents make **outbound** WebSocket connections (to a single TLS port the operator is already comfortable with), and the Hub matches them up by session code. No inbound rules, no port forwarding, no STUN/TURN.

The cost of relaying through a Hub is exactly that the Hub becomes a witness to the encrypted traffic — and the architectural choice that makes ValidatorShift safe is that **the Hub is a coordination plane, not a trust plane**:

- Both ends authenticate **each other**, not the Hub. The SAS comparison establishes peer identity; a malicious Hub mounting a MITM creates two divergent SAS displays and the operator catches it.
- Encryption keys are derived from X25519 ECDH between the two agents. Hub compromise reveals only ciphertext.
- Audit trail is structured events; the Hub cannot inject false confirmations because destructive operator gates run inside the agent's TTY, not the Hub's WebSocket.

If a future iteration removes the Hub (e.g. via a libp2p-based direct relay or a standardized hole-punching protocol), the security model is unchanged — the agents already do all real authentication. The Hub is a deployment-friendliness optimization on top of an end-to-end-secure protocol.

## Residual risks the operator owns

ValidatorShift defends the migration **window**. Threats outside that window remain the operator's responsibility:

- **Storage-layer wipe limitations.** `secureWipe` overwrites the keypair file with cryptographic random bytes, calls `fsync`, then `unlink`. On copy-on-write filesystems (btrfs, ZFS) and on SSDs with internal wear-levelling, the original blocks may persist unmapped on physical media — recoverable by an attacker with physical disk access. For high-value identities, operators should plan an identity rotation post-migration via on-chain `vote authorize-voter` regardless of how successful the migration appears.
- **Oracle compromise.** Whatever entity confirms "yes, that pubkey is voting" — the cluster RPC the agent queries during preflight and step 8 — is trusted as ground truth. We do not run a separate cluster oracle. If the operator's RPC node lies (because it is malicious, or because it is desync'd), the agent may pass step 8 while target is in fact silent. **Out of scope** for ValidatorShift; mitigated operationally by using a trusted RPC and by independent third-host verification per [docs/RECOVERY.md](./RECOVERY.md).
- **Host-OS compromise.** Malicious kernel modules, rootkits, backdoored Node.js or `agave-validator` binaries, or a poisoned `npm` registry can exfiltrate the keypair before the agent encrypts it. ValidatorShift's installer verifies SHA-256 against a published `SHA256SUMS` from GitHub Releases (see [scripts/install.sh](../scripts/install.sh)), but the operator must trust the underlying OS.
- **Side channels on the agent process.** RAM scraping, cold-boot attacks, hypervisor introspection, EM emanation. Out of scope.
- **Operator error in SAS verification.** If you click "confirm" without comparing all displayed SAS strings, you opt out of MITM protection. ValidatorShift cannot enforce visual comparison from inside the software.
- **Long-term backup management.** ValidatorShift does not encrypt or manage operator-held offline backups of the keypair. Backup hygiene before, during, and after a migration is the operator's job.

See [docs/SECURITY.md](./SECURITY.md) for the protocol primitives and responsible disclosure process. See [docs/RECOVERY.md](./RECOVERY.md) for failure-mode runbooks.
