import { describe, it, expect } from 'vitest'
import { parseMessage } from './protocol.js'

describe('parseMessage', () => {
  describe('AgentMessage', () => {
    it('parses agent:hello', () => {
      const msg = {
        type: 'agent:hello',
        role: 'source',
        sessionCode: 'X7K9M2',
        publicKey: 'abc123',
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.data).toEqual(msg)
      }
    })

    it('parses agent:sas_confirmed', () => {
      const msg = { type: 'agent:sas_confirmed' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses agent:preflight_result', () => {
      const msg = {
        type: 'agent:preflight_result',
        checks: [
          { name: 'cli_installed', ok: true },
          { name: 'caught_up', ok: false, detail: 'behind by 100 slots' },
        ],
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses agent:step_complete', () => {
      const msg = {
        type: 'agent:step_complete',
        step: 1,
        result: { ok: true, output: 'done', durationMs: 1234 },
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses agent:step_failed', () => {
      const msg = { type: 'agent:step_failed', step: 2, error: 'boom' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses agent:encrypted_payload', () => {
      const msg = {
        type: 'agent:encrypted_payload',
        payload: 'base64data==',
        hash: 'sha256hash',
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses agent:log', () => {
      const msg = { type: 'agent:log', level: 'info', message: 'hello' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })
  })

  describe('HubToAgentMessage', () => {
    it('parses hub:peer_connected', () => {
      const msg = { type: 'hub:peer_connected', peerPublicKey: 'pubkey123' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses hub:verify_sas', () => {
      const msg = { type: 'hub:verify_sas', sas: 'ALPHA-BRAVO-CHARLIE' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses hub:run_preflight', () => {
      const msg = { type: 'hub:run_preflight' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses hub:execute_step', () => {
      const msg = { type: 'hub:execute_step', step: 3 }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses hub:rollback', () => {
      const msg = { type: 'hub:rollback' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses hub:relay_payload', () => {
      const msg = {
        type: 'hub:relay_payload',
        payload: 'b64==',
        hash: 'sha256',
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses hub:session_cancelled', () => {
      const msg = { type: 'hub:session_cancelled' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })
  })

  describe('HubToDashboardMessage', () => {
    it('parses dashboard:state_change', () => {
      const msg = {
        type: 'dashboard:state_change',
        state: 'PAIRING',
        prevState: 'IDLE',
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses dashboard:agents_status', () => {
      const msg = {
        type: 'dashboard:agents_status',
        source: { role: 'source', connected: true, publicKey: 'p1', lastSeen: 1 },
        target: { role: 'target', connected: false },
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses dashboard:preflight_update', () => {
      const msg = {
        type: 'dashboard:preflight_update',
        checks: [{ name: 'cli', ok: true }],
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses dashboard:step_progress', () => {
      const msg = { type: 'dashboard:step_progress', step: 5, status: 'running' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses dashboard:log', () => {
      const msg = {
        type: 'dashboard:log',
        agent: 'source',
        level: 'info',
        message: 'hi',
        ts: 1234,
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses dashboard:migration_complete', () => {
      const msg = {
        type: 'dashboard:migration_complete',
        summary: {
          startedAt: 1,
          finishedAt: 2,
          durationMs: 1,
          stepsCompleted: 9,
          finalState: 'COMPLETE',
        },
      }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })
  })

  describe('DashboardMessage', () => {
    it('parses dashboard:start_migration', () => {
      const msg = { type: 'dashboard:start_migration' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses dashboard:abort', () => {
      const msg = { type: 'dashboard:abort' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })

    it('parses dashboard:confirm_sas', () => {
      const msg = { type: 'dashboard:confirm_sas' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.data).toEqual(msg)
    })
  })

  describe('negative cases', () => {
    it('rejects invalid type', () => {
      const msg = { type: 'totally:bogus', foo: 'bar' }
      const r = parseMessage(JSON.stringify(msg))
      expect(r.ok).toBe(false)
    })

    it('rejects malformed JSON', () => {
      const r = parseMessage('not json {')
      expect(r.ok).toBe(false)
    })
  })
})
