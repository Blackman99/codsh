#!/usr/bin/env node
/**
 * Deterministic ACP stdio stand-in for protocol-mismatch and disconnect tests.
 * Extra CLI arguments are ignored so it can be pointed at by DSH_BIN.
 */
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_ACP_MODE ?? 'echo'
const version = Number(process.env.FAKE_ACP_VERSION ?? (mode === 'mismatch' ? 99 : 1))
const delayMs = Number(process.env.FAKE_ACP_DELAY_MS ?? (mode.startsWith('slow') ? '1500' : '0'))
const pending = []
let permissionPrompt = null
let permissionSeq = 0
let inflightPrompt = null
let cancelled = false
let writes = Number(process.env.FAKE_ACP_WRITES ?? '0')

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function requestPermission(sessionId, toolCallId, rawInput, title, promptId) {
  permissionSeq += 1
  const permissionId = `perm-${permissionSeq}`
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        kind: title === 'read' ? 'read' : 'edit',
        status: 'pending',
        rawInput,
      },
    },
  })
  send({
    jsonrpc: '2.0',
    id: permissionId,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  })
  permissionPrompt = { permissionId, promptId, sessionId, toolCallId, rawInput, title }
}

function writeTarget() {
  const target = process.env.FAKE_ACP_TARGET
  if (!target) return
  writes += 1
  process.env.FAKE_ACP_WRITES = String(writes)
  writeFileSync(target, `FAKE_ACP_WROTE count=${writes}\n`)
}

function finishPermission(outcome) {
  const current = permissionPrompt
  permissionPrompt = null
  if (current === null) return
  const allowed = outcome?.outcome === 'selected' && outcome.optionId === 'allow-once'
  const permissionCancelled = outcome?.outcome === 'cancelled' || cancelled
  if (allowed && !permissionCancelled) writeTarget()
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: current.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: current.toolCallId,
        status: allowed ? 'completed' : 'failed',
        content: [{
          type: 'content',
          content: {
            type: 'text',
            text: allowed ? 'Created file' : 'the user rejected tool "write"',
          },
        }],
      },
    },
  })
  if (current.promptId != null && inflightPrompt?.id === current.promptId) {
    finishPrompt(current.promptId, allowed && !permissionCancelled ? 'end_turn' : (permissionCancelled ? 'cancelled' : 'end_turn'))
  }
}

function finishPrompt(id, stopReason) {
  if (inflightPrompt?.id !== id) return
  inflightPrompt = null
  send({ jsonrpc: '2.0', id, result: { stopReason } })
}

function cancelSession() {
  cancelled = true
  if (inflightPrompt?.timer) clearTimeout(inflightPrompt.timer)
  if (permissionPrompt) {
    const current = permissionPrompt
    permissionPrompt = null
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: current.sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: current.toolCallId,
          status: 'cancelled',
          content: [{
            type: 'content',
            content: { type: 'text', text: 'tool cancelled' },
          }],
        },
      },
    })
  }
  if (inflightPrompt) {
    const id = inflightPrompt.id
    const sessionId = inflightPrompt.sessionId
    if (mode === 'late-after-cancel') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'fake-msg-late',
            content: { type: 'text', text: 'FAKE_ACP_LATE_AFTER_CANCEL' },
          },
        },
      })
    }
    finishPrompt(id, 'cancelled')
  }
}

function answerPrompt(id, params) {
  cancelled = false
  const sessionId = params?.sessionId ?? 'fake-session'
  const text = Array.isArray(params?.prompt)
    ? params.prompt.filter(block => block?.type === 'text').map(block => block.text).join('')
    : ''
  inflightPrompt = { id, sessionId, text, timer: null }
  if (mode === 'slow-stream' || mode === 'late-after-cancel') {
    inflightPrompt.timer = setTimeout(() => {
      if (cancelled || inflightPrompt?.id !== id) return
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'fake-msg-slow',
            content: { type: 'text', text: `FAKE_ACP_ANSWER ${text}` },
          },
        },
      })
      finishPrompt(id, 'end_turn')
    }, Number.isFinite(delayMs) ? delayMs : 1500)
    return
  }
  if (mode === 'slow-tool') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'fake-slow-write',
          title: 'write',
          kind: 'edit',
          status: 'in_progress',
          rawInput: { file_path: 'note.txt', content: 'FAKE_ACP_WROTE\n' },
        },
      },
    })
    inflightPrompt.timer = setTimeout(() => {
      if (cancelled || inflightPrompt?.id !== id) return
      writeTarget()
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'fake-slow-write',
            status: 'completed',
            content: [{
              type: 'content',
              content: { type: 'text', text: 'Created file' },
            }],
          },
        },
      })
      finishPrompt(id, 'end_turn')
    }, Number.isFinite(delayMs) ? delayMs : 1500)
    return
  }
  if (mode === 'permission' || mode === 'permission-stale') {
    requestPermission(sessionId, 'fake-write-1', {
      file_path: 'note.txt',
      content: 'FAKE_ACP_WROTE\n',
    }, 'write', id)
    if (mode === 'permission-stale') {
      requestPermission(sessionId, 'fake-write-2', {
        file_path: 'note.txt',
        content: 'FAKE_ACP_STALE\n',
      }, 'write', id)
    }
    return
  }
  if (mode === 'file-missing') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'fake-read-missing',
          title: 'read',
          kind: 'read',
          status: 'in_progress',
          rawInput: { file_path: 'missing-note.txt' },
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'fake-read-missing',
          status: 'failed',
          content: [{
            type: 'content',
            content: { type: 'text', text: 'cannot read "missing-note.txt": not found' },
          }],
        },
      },
    })
    finishPrompt(id, 'end_turn')
    return
  }
  if (mode === 'file-error') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'fake-edit-miss',
          title: 'edit',
          kind: 'edit',
          status: 'in_progress',
          rawInput: { file_path: 'note.txt', old_string: 'NO_SUCH_HUNK', new_string: 'patched' },
        },
      },
    })
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'fake-edit-miss',
          status: 'failed',
          content: [{
            type: 'content',
            content: { type: 'text', text: 'Error: old_string not found in note.txt' },
          }],
        },
      },
    })
    finishPrompt(id, 'end_turn')
    return
  }
  if (mode === 'empty') {
    finishPrompt(id, 'end_turn')
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
    inflightPrompt = null
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
  finishPrompt(id, 'end_turn')
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
  if (method === undefined && id != null && permissionPrompt?.permissionId === id) {
    finishPermission(msg.result?.outcome)
    return
  }
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
  if (method === 'session/cancel') {
    cancelSession()
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
