#!/usr/bin/env node
/**
 * Deterministic ACP stdio stand-in for protocol-mismatch and disconnect tests.
 * Extra CLI arguments are ignored so it can be pointed at by DSH_BIN.
 */
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_ACP_MODE ?? 'echo'
const version = Number(process.env.FAKE_ACP_VERSION ?? (mode === 'mismatch' ? 99 : 1))
const pending = []

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function answerPrompt(id, params) {
  const sessionId = params?.sessionId ?? 'fake-session'
  const text = Array.isArray(params?.prompt)
    ? params.prompt.filter(block => block?.type === 'text').map(block => block.text).join('')
    : ''
  if (mode === 'empty') {
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }
  if (mode === 'fail') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'fake-msg-partial',
          content: { type: 'text', text: 'FAKE_ACP_PARTIAL' },
        },
      },
    })
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'fake agent failed mid-stream' } })
    return
  }
  if (mode === 'drop') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'fake-msg-drop',
          content: { type: 'text', text: 'FAKE_ACP_DROPPED' },
        },
      },
    })
    process.stdout.end(() => process.exit(0))
    return
  }
  if (mode === 'reasoning') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 'fake-msg-1',
          content: { type: 'text', text: 'FAKE_ACP_THOUGHT' },
        },
      },
    })
  }
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: mode === 'reasoning' ? 'fake-msg-1' : 'fake-msg-echo',
        content: { type: 'text', text: `FAKE_ACP_ANSWER ${text}` },
      },
    },
  })
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: version,
        agentInfo: { name: 'fake-acp-agent', version: '0.0.0' },
        agentCapabilities: { sessionCapabilities: {} },
        authMethods: [],
      },
    })
    return
  }
  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'fake-session', configOptions: [] } })
    return
  }
  if (method === 'session/prompt') {
    answerPrompt(id, params)
    return
  }
  if (method === 'session/close') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
})
rl.on('close', () => {
  pending.length = 0
  process.exit(0)
})
