/**
 * Subagent messaging and continuation (ticket 173): the pure pieces the
 * `send_subagent_message` tool and `resume_from` share. The lifecycle lives
 * in rust-acp-subagents.mjs, which owns the children.
 *
 * Reference: grok-build SOURCE_REV e8563f8, user guide 16 ("Sending messages
 * to subagents", "resume_from") and the task coordinator's active-message
 * outcomes. The model-facing strings below are the reference ones.
 */

export const MESSAGE_TOOL = 'send_subagent_message'
/** dsh's own follow-up tools. They reach only continuable children, which this client never starts. */
export const DSH_MESSAGE_TOOLS = ['send_message', 'interrupt_agent']
export const MAX_MESSAGE_BYTES = 32 * 1024
/** Unclaimed accepted messages per target child, and across the process. */
export const MAX_ADMISSIONS_PER_CHILD = 8
export const MAX_ADMISSIONS = 64
/** A subagent sender: in flight per sender-target pair, and outbound per sender attempt. */
export const MAX_SENDER_TARGET_IN_FLIGHT = 4
export const MAX_ATTEMPT_OUTBOUND = 32
/** Settled children kept live for a message or resume_from; the oldest is released first. */
export const MAX_RESIDENT_CHILDREN = 32
export const DELIVERIES = ['steer', 'queue', 'interject']

export const MESSAGE_TOOL_DESCRIPTION = 'Send a follow-up message to a subagent owned by this session. When called by a subagent, `parent` targets an active parent subagent, and a known agent ID targets another local subagent; an eligible completed subagent resumes with the same identity. For an active target, `delivery` selects how the message lands: `steer` (default) joins the current turn at its next safe point; `queue` waits as a later turn; `interject` is urgent — it is delivered ahead of pending steers at the earliest safe point and interrupts a subagent blocked waiting on background work.'

export const INVALID_TARGET = 'subagent_id must be `parent` or a valid agent ID'

export const RESUME_FROM_DESCRIPTION = "Continue a completed subagent's conversation. Pass its subagent ID."

/** Blank, empty, or "null" resume_from is absent (models emit these). */
export function resumeSource(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '' || text.toLowerCase() === 'null' || text.toLowerCase() === 'none' || text.toLowerCase() === 'undefined') return undefined
  return text
}

/** `parent`, or an id this client could have minted (call ids and dsh session ids). */
export function validTarget(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === 'parent') return text
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(text) ? text : undefined
}

/** `delivery` wins; the legacy `queue: true` means queue; steer otherwise. */
export function parseDelivery(args) {
  const delivery = args?.delivery
  if (typeof delivery === 'string' && delivery !== '') {
    if (!DELIVERIES.includes(delivery)) throw new Error(`delivery must be one of ${DELIVERIES.join(', ')}`)
    return delivery
  }
  return args?.queue === true ? 'queue' : 'steer'
}

/** Outcome -> the reference sentence. */
export function outcomeText(outcome) {
  switch (outcome.outcome) {
    case 'accepted': return `Message accepted (message_id: ${outcome.message_id}).`
    case 'not_found_or_not_owned': return 'Subagent not found or not owned by this session.'
    case 'not_active_or_finalizing': return 'Subagent is not active or is finalizing.'
    case 'saturated': return `Message admission is saturated (maximum ${outcome.max_in_flight} in flight).`
    case 'quota_exceeded': return `Agent-message quota exceeded (${outcome.kind}, limit ${outcome.limit}).`
    case 'admission_uncertain': return 'Message admission could not be confirmed; the message may or may not have been accepted.'
    case 'not_accepted_before_deadline': return 'Message was not accepted before the delivery deadline.'
    case 'unsupported': return 'Active agent messages are unsupported in this context.'
    case 'limit': return `Message size is invalid: observed ${outcome.observed_bytes} bytes; maximum is ${outcome.max_bytes} bytes.`
    case 'channel_closed': return 'Message was not accepted because the subagent channel closed.'
    default: return `Message outcome ${String(outcome.outcome)}.`
  }
}

/** accepted, unconfirmed (admission_uncertain), or rejected. */
export function disposition(outcome) {
  if (outcome.outcome === 'accepted') return 'accepted'
  if (outcome.outcome === 'admission_uncertain') return 'unconfirmed'
  return 'rejected'
}

/** The size gate: empty text is observed as 0 bytes. */
export function sizeOutcome(text) {
  const observed = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0
  if (observed === 0 || observed > MAX_MESSAGE_BYTES) return { outcome: 'limit', max_bytes: MAX_MESSAGE_BYTES, observed_bytes: observed }
  return undefined
}

/** The text the target reads (dsh's agent-message form), naming the sender. */
export function relayText(from, text) {
  return `${from} sent a message: ${text}`
}

export const RESUME_ERRORS = {
  running: id => `Cannot resume from subagent '${id}': it is still running. Wait for it to complete before resuming.`,
  missing: id => `Cannot resume from subagent '${id}': not found. The subagent may have been evicted or the ID is invalid.`,
  isolated: id => `Cannot resume from subagent '${id}': it ran in an isolated worktree, which this client does not resume. Start a new subagent instead.`,
  type: (requested, source) => `Cannot resume with subagent_type '${requested}': source subagent was '${source}'. Resumed sessions must use the same subagent type as the source.`,
  model: (id, model, detail) => `Cannot resume from subagent '${id}': source model '${model}' is no longer available (${detail}).`,
}
