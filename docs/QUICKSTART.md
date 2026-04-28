# Quick start

This guide takes you from a fresh `git clone` to your first end-to-end testnet validator identity migration with ValidatorShift.

## Prerequisites

- **Node.js 20+** on the machine running the Hub and Web UI.
- **Docker** + `docker-compose` (recommended for the Hub/Web deployment).
- **Two validator servers** — a source (currently staked) and a target — both with:
  - The Solana CLI (`solana`, `solana-validator`) installed and on `PATH`.
  - A running `solana-validator` process (testnet for first migrations).
  - Network egress to your Hub on the chosen WSS port.
- The source server's `validator-keypair.json` and ledger directory paths handy.

## 1. Deploy the Hub

Locally, or on a VPS the two validator servers can reach:

```bash
git clone https://github.com/Eternally-black/validator-shift
cd validator-shift
docker-compose up -d
```

This brings up two services:

- **hub** — REST API on `:3001`, WebSocket on `:3002`.
- **web** — Next.js UI on `:3000`.

Confirm they are healthy:

```bash
docker-compose ps
curl http://localhost:3001/health
```

For a public deployment, point a TLS-terminating reverse proxy (Caddy, nginx, Cloudflare) at `:3001` and `:3002`, and set `NEXT_PUBLIC_HUB_URL=wss://hub.your-domain` for the `web` service.

## 2. Open the Web UI

Visit `http://localhost:3000` (or your public URL).

1. Click **Start Migration**.
2. Fill in:
   - Source server label (e.g. `validator-old.example.com`).
   - Target server label (e.g. `validator-new.example.com`).
   - Source `--ledger` path (e.g. `/mnt/ledger`).
   - Source `--keypair` path (e.g. `/var/lib/solana/validator-keypair.json`).
   - Target ledger and keypair destination paths.
3. The wizard will display a **6-character session code** (e.g. `ABC123`). Keep this tab open.

## 3. Run agents on both validator servers

On the **source** server:

```bash
npx @validator-shift/agent \
  --role source \
  --session ABC123 \
  --hub wss://your-hub:3002 \
  --ledger /mnt/ledger \
  --keypair /var/lib/solana/validator-keypair.json
```

On the **target** server:

```bash
npx @validator-shift/agent \
  --role target \
  --session ABC123 \
  --hub wss://your-hub:3002 \
  --ledger /mnt/ledger \
  --keypair /var/lib/solana/validator-keypair.json
```

Both agents will connect to the Hub, perform an X25519 key exchange, and print a 3-word **SAS** (Short Authentication String), e.g. `ALPHA-BRAVO-CHARLIE`. The same SAS will appear in the Web UI.

## 4. Verify, preflight, migrate

1. **SAS verification** — visually confirm the 3-word code matches in *both* terminals **and** the Web UI. If any of the three differ, abort: a man-in-the-middle is the only explanation.
2. **Pre-flight checks** — the Web UI runs Solana CLI accessibility, validator caught-up status, vote-account match, disk space, ledger writability, and "no existing staked identity on target" checks. Each must be green.
3. **Start Migration** — click the button. Watch the live state machine: `MIGRATING` cycles through wait-for-restart-window, deactivate source, transfer tower file, transfer keypair, activate target, post-flight gossip verification, and secure wipe. The log stream from both agents is mirrored in the dashboard in real time.
4. **Complete** — on success the Web UI shows total elapsed time and a "Verify on Explorer" link to `solana.fm/validators/<pubkey>`. The source keypair has been securely overwritten and unlinked.

If any step fails after deactivation, the rollback protocol re-activates the source automatically. The keypair always exists in at least one place until migration is verified.

## Troubleshooting

**`better-sqlite3` build errors on Windows.**
The Hub's SQLite binding requires native compilation. Install build tools first: `npm install --global windows-build-tools` (legacy) or install Visual Studio 2022 with the "Desktop development with C++" workload, then `npm rebuild better-sqlite3`. On WSL2 / Linux this is rarely an issue.

**Port collisions on `:3000` / `:3001` / `:3002`.**
Edit `docker-compose.yml` and remap the host-side ports (e.g. `"3010:3000"`). Update `NEXT_PUBLIC_HUB_URL` accordingly. If running natively, set `PORT`, `HUB_HTTP_PORT`, and `HUB_WS_PORT` environment variables before `npm run dev`.

**Firewall blocks `:3001` / `:3002`.**
Both validator servers need outbound access to the Hub's WebSocket port (default `3002`). Web UI users need access to `3000` (or whatever you remapped). Check `ufw`/`iptables`/cloud security groups: `sudo ufw allow 3002/tcp` on the Hub, and verify with `nc -vz your-hub 3002` from each validator.

**Agent hangs at "waiting for peer".**
The other agent has not connected with the same `--session` code. Double-check the code (case-sensitive) and that both agents target the same `--hub` URL.
