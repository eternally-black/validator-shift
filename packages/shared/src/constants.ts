export const SESSION_CODE_LENGTH = 6
export const SESSION_TTL_MS = 5 * 60_000
export const MIGRATION_STEPS = [
  { number: 1, name: 'wait_for_restart_window', executor: 'source' },
  { number: 2, name: 'set_unstaked_identity_source', executor: 'source' },
  { number: 3, name: 'remove_authorized_voters_source', executor: 'source' },
  { number: 4, name: 'transfer_tower_file', executor: 'source' },
  { number: 5, name: 'transfer_identity_keypair', executor: 'source' },
  { number: 6, name: 'set_staked_identity_target', executor: 'target' },
  { number: 7, name: 'add_authorized_voter_target', executor: 'target' },
  { number: 8, name: 'post_migration_verify', executor: 'target' },
  { number: 9, name: 'cleanup_source', executor: 'source' },
] as const
export const TOWER_FILE_REGEX = /^tower-1_9-[A-Za-z0-9]+\.bin$/
export const DEFAULT_HUB_HTTP_PORT = 3001
export const DEFAULT_HUB_WS_PORT = 3002
export const HEARTBEAT_INTERVAL_MS = 15_000
export const PAIRING_RECONNECT_MAX_ATTEMPTS = 5
