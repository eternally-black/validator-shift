# Security

ValidatorShift moves the most sensitive material a Solana operator owns — the staked validator keypair — between two servers. This document explains the threat model, the cryptographic primitives we rely on, the invariants the Hub maintains, and how to disclose vulnerabilities.

## Threat model

| Threat | Mitigation |
|--------|------------|
| Key interception during transfer | E2E encryption (X25519 + XChaCha20-Poly1305) between source and target agents |
| Compromised Hub server | Hub never sees plaintext key; only encrypted, authenticated blobs pass through |
| Man-in-the-middle on pairing | Short Authentication String (SAS) verification, like Signal — operator confirms 3 NATO words on both terminals and Web UI |
| Dual-signing / double identity | Anti-dual-identity protocol with sequential execution, gossip verification, and lockout-on-disconnect |
| Failed migration leaves orphaned state | Automatic rollback driven by a deterministic state machine |
| Key remains on source after transfer | Secure wipe (random overwrite + `unlink`) after post-flight verification |

## Cryptographic choices

- **Key agreement**: X25519 (Curve25519 ECDH). Each agent generates an ephemeral keypair per session; the Hub relays public keys but cannot derive the shared secret.
- **Symmetric encryption**: XChaCha20-Poly1305 AEAD. 24-byte random nonces, 16-byte Poly1305 tag, no nonce reuse possible per session.
- **KDF**: HKDF-SHA256 over the X25519 shared secret. Two keys derived with distinct `info` labels:
  1. **Session payload key** — encrypts tower file and keypair payloads end-to-end.
  2. **SAS key** — encodes a deterministic 3-word fingerprint identical on both ends.

## Hub invariant

> **The Hub never decrypts payloads and never stores keys.**

The Hub stores: session metadata, audit-log entries (state transitions, timestamps, agent identifiers), and the public keys exchanged during pairing. It does **not** store, log, or transit any plaintext private material. Encrypted relay blobs are forwarded byte-for-byte and discarded after delivery confirmation. Even a fully compromised Hub — root access, SQLite dump, in-memory inspection — cannot recover a validator keypair.

This is enforced architecturally: the agent's `crypto/` module owns key derivation; the Hub binary has no XChaCha20 decryption primitive linked into it.

## SAS verification

After pairing, both agents derive an identical 3-word **Short Authentication String** from the X25519 shared secret using the SAS key and a NATO phonetic wordlist (e.g. `ALPHA-BRAVO-CHARLIE`).

The SAS is displayed in three places:

1. The **source** agent's terminal.
2. The **target** agent's terminal.
3. The Web UI dashboard.

The operator must visually confirm all three are identical before approving the migration. A mismatch indicates a Hub-level man-in-the-middle attempting to pair each agent with its own substitute keypair, and the session must be aborted. The SAS is the single human-verified anchor that makes Hub compromise survivable.

## Anti-dual-identity protocol

Two validators voting with the same staked identity simultaneously is the worst-case Solana operational failure. ValidatorShift prevents it with three overlapping mechanisms:

- **Sequential execution.** The state machine guarantees source deactivation (`set-identity` to unstaked + `authorized-voter remove-all`) completes before any activation step on the target.
- **Gossip verification.** After source deactivation, the Hub queries cluster gossip until it observes the source pubkey is no longer signing votes. Only then is the target authorized to take over.
- **Lockout on disconnect.** If either agent loses its WebSocket during `MIGRATING`, the Hub triggers automatic rollback and refuses to issue further `execute_step` messages until operator intervention.

## Tower file integrity

The tower file (`tower-1_9-<pubkey>.bin`) records voting lockouts. A corrupted tower can cause lockout violations. ValidatorShift:

1. Computes SHA-256 of the tower on the source before transfer.
2. Encrypts and relays the bytes through the Hub.
3. Re-computes SHA-256 on the target after decryption.
4. Aborts and rolls back on hash mismatch.

## Secure wipe of the source keypair

After the target is verified voting and the source is verified silent, the source agent securely destroys the keypair file:

```ts
const fileSize = fs.statSync(keypairPath).size;
const randomBytes = crypto.randomBytes(fileSize);
fs.writeFileSync(keypairPath, randomBytes);
fs.unlinkSync(keypairPath);
```

The file is overwritten with cryptographic random bytes of the original length, then unlinked. On copy-on-write filesystems (btrfs, ZFS) or SSDs with wear-levelling this is best-effort — operators handling extreme threat models should additionally wipe or destroy the underlying storage media.

## Known issues

CI runs `npm audit --audit-level=critical` on every push. Three high-severity items are currently unfixed because their published patches are major-version breaking changes that need a dedicated upgrade pass and a redeploy retest. None affect the in-flight migration's confidentiality or integrity (they're DoS / header-spoofing classes against the hub, not the agent or the encrypted relay):

- **fastify ≤ 5.8.2** ([GHSA-mrq3-vjjr-p77c](https://github.com/advisories/GHSA-mrq3-vjjr-p77c), [GHSA-jx2c-rxcm-jvmq](https://github.com/advisories/GHSA-jx2c-rxcm-jvmq), [GHSA-444r-cwp2-x5xf](https://github.com/advisories/GHSA-444r-cwp2-x5xf)). Hub uses `fastify ^4.26.0`. Fix path: bump to fastify 5.x + verify `@fastify/cors`, `@fastify/rate-limit`, `@fastify/websocket` plugin compatibility.
- **postcss < 8.5.10** ([GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93)). Transitive via `next`. Fix path: Next.js minor upgrade once a clean release ships.

These are tracked for the post-submission sprint. The hub is not currently exposed to the request paths the fastify advisories describe (no `sendWebStream` usage; rate-limit middleware doesn't trust X-Forwarded-* against unauthenticated peers; we don't body-validate via the affected Content-Type path).

## Responsible disclosure

Please report security issues via <https://github.com/Eternally-black/validator-shift/security/advisories/new> (GitHub private vulnerability reporting).

Do **not** open a public issue, post on Discord, or tweet about the vulnerability before we have published a fix and an advisory. We aim to acknowledge reports within 48 hours and to publish a coordinated advisory within 30 days.

## Out of scope

The following threats are **not** covered by ValidatorShift's design and remain the operator's responsibility:

- **Physical access** to either validator server. Anyone with root or disk access on the source before migration completes can copy the keypair directly.
- **Compromised host OS / supply chain.** Malicious kernel modules, rootkits, backdoored Node.js or `solana-validator` binaries, or a poisoned `npm` registry can exfiltrate the key before the agent encrypts it.
- **Side-channel attacks** on the agent process (RAM scraping, cold-boot attacks, hypervisor introspection).
- **Operator error in SAS verification.** If you click "confirm" without comparing all three SAS displays, you opt out of MITM protection.
- **Long-term storage of backups.** ValidatorShift does not encrypt or manage operator-held keypair backups outside the migration window.
- **Solana protocol-level slashing rules.** ValidatorShift minimizes dual-identity windows but does not modify or override on-chain consensus behavior.
- **Network availability / DoS** of the Hub. Availability is not a security guarantee; a stalled migration is recoverable, but uptime is the operator's deployment concern.
