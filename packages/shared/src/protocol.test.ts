import { describe, it, expect } from 'vitest'
import { parseMessage } from './protocol'

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

  describe('edge: non-object inputs', () => {
    it('rejects bare "not-json" string', () => {
      const r = parseMessage('not-json')
      expect(r.ok).toBe(false)
    })

    it('rejects empty object "{}"', () => {
      const r = parseMessage('{}')
      expect(r.ok).toBe(false)
    })

    it('rejects "null"', () => {
      const r = parseMessage('null')
      expect(r.ok).toBe(false)
    })

    it('rejects "[]"', () => {
      const r = parseMessage('[]')
      expect(r.ok).toBe(false)
    })

    it('rejects bare number / boolean / string JSON', () => {
      expect(parseMessage('42').ok).toBe(false)
      expect(parseMessage('true').ok).toBe(false)
      expect(parseMessage('"hello"').ok).toBe(false)
    })

    it('rejects truncated JSON object', () => {
      expect(parseMessage('{"type":').ok).toBe(false)
    })
  })

  /**
   * Negative-fuzz: for each valid message example we generate three
   * mutations:
   *   1) drop a required (non-`type`) field
   *   2) replace `type` with a wrong literal
   *   3) corrupt the type of a required field (string <-> number)
   *
   * Every mutation must round-trip to { ok: false } via parseMessage.
   */
  describe('negative-fuzz: every variant rejects each common mutation', () => {
    type Example = { name: string; msg: Record<string, unknown> }

    const examples: Example[] = [
      {
        name: 'agent:hello',
        msg: {
          type: 'agent:hello',
          role: 'source',
          sessionCode: 'X7K9M2',
          publicKey: 'abc123',
        },
      },
      {
        name: 'agent:preflight_result',
        msg: {
          type: 'agent:preflight_result',
          checks: [{ name: 'cli', ok: true }],
        },
      },
      {
        name: 'agent:step_complete',
        msg: {
          type: 'agent:step_complete',
          step: 1,
          result: { ok: true, durationMs: 10 },
        },
      },
      {
        name: 'agent:step_failed',
        msg: { type: 'agent:step_failed', step: 2, error: 'boom' },
      },
      {
        name: 'agent:encrypted_payload',
        msg: {
          type: 'agent:encrypted_payload',
          payload: 'b64',
          hash: 'sha',
        },
      },
      {
        name: 'agent:log',
        msg: { type: 'agent:log', level: 'info', message: 'hi' },
      },
      {
        name: 'hub:peer_connected',
        msg: { type: 'hub:peer_connected', peerPublicKey: 'pk' },
      },
      {
        name: 'hub:verify_sas',
        msg: { type: 'hub:verify_sas', sas: 'A-B-C' },
      },
      {
        name: 'hub:execute_step',
        msg: { type: 'hub:execute_step', step: 3 },
      },
      {
        name: 'hub:relay_payload',
        msg: { type: 'hub:relay_payload', payload: 'b64', hash: 'sha' },
      },
      {
        name: 'dashboard:state_change',
        msg: {
          type: 'dashboard:state_change',
          state: 'PAIRING',
          prevState: 'IDLE',
        },
      },
      {
        name: 'dashboard:agents_status',
        msg: {
          type: 'dashboard:agents_status',
          source: { role: 'source', connected: true },
          target: { role: 'target', connected: false },
        },
      },
      {
        name: 'dashboard:preflight_update',
        msg: {
          type: 'dashboard:preflight_update',
          checks: [{ name: 'cli', ok: true }],
        },
      },
      {
        name: 'dashboard:step_progress',
        msg: {
          type: 'dashboard:step_progress',
          step: 1,
          status: 'running',
        },
      },
      {
        name: 'dashboard:log',
        msg: {
          type: 'dashboard:log',
          agent: 'source',
          level: 'info',
          message: 'm',
          ts: 1,
        },
      },
      {
        name: 'dashboard:migration_complete',
        msg: {
          type: 'dashboard:migration_complete',
          summary: {
            startedAt: 1,
            finishedAt: 2,
            durationMs: 1,
            stepsCompleted: 9,
            finalState: 'COMPLETE',
          },
        },
      },
    ]

    // Sanity: confirm baseline examples themselves all parse OK so we
    // know the mutations (not the bases) are what trigger failures.
    it('baseline examples are all valid', () => {
      for (const ex of examples) {
        const r = parseMessage(JSON.stringify(ex.msg))
        expect(r.ok, `${ex.name} baseline must parse`).toBe(true)
      }
    })

    for (const ex of examples) {
      describe(ex.name, () => {
        it('mutation 1: drop a required non-type field', () => {
          const otherKeys = Object.keys(ex.msg).filter((k) => k !== 'type')
          // Some variants only have `type` (no other required field) -
          // skip those: there is nothing to drop.
          if (otherKeys.length === 0) return
          const dropped = { ...ex.msg }
          delete (dropped as Record<string, unknown>)[otherKeys[0]!]
          const r = parseMessage(JSON.stringify(dropped))
          expect(r.ok).toBe(false)
        })

        it('mutation 2: replace type with a wrong literal', () => {
          const mutated = { ...ex.msg, type: 'totally:not_a_real_type' }
          const r = parseMessage(JSON.stringify(mutated))
          expect(r.ok).toBe(false)
        })

        it('mutation 3: corrupt the type of a required field', () => {
          const otherKeys = Object.keys(ex.msg).filter((k) => k !== 'type')
          if (otherKeys.length === 0) return
          const key = otherKeys[0]!
          const original = (ex.msg as Record<string, unknown>)[key]
          // Flip primitive type: string <-> number; for everything else
          // (object/array/boolean) substitute a number, which is never
          // a valid shape for any field in our schemas.
          const corrupted: unknown =
            typeof original === 'string'
              ? 12345
              : typeof original === 'number'
                ? 'not-a-number'
                : 12345
          const mutated = { ...ex.msg, [key]: corrupted }
          const r = parseMessage(JSON.stringify(mutated))
          expect(r.ok).toBe(false)
        })
      })
    }
  })
})
