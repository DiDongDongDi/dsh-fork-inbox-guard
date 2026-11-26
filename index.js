// dsh-fork-inbox-guard — host half
//
// Fork copies the parent log through the selected turn. A prompt queued during
// that turn is an agent/inbox/spliced insert inside the prefix; the matching
// removal lands on the next turn, past the cut. The child inbox folds the
// prefix and therefore wakes up holding the parent's queue.
//
// On agent/created (and for agents already live when this plugin loads), cancel
// only the pending items whose inserting splice is inside the inherited prefix.
// Unseeded sessions and prompts the child queued itself are left alone.
// No client seat, no transcript notice.

export const name = 'fork-inbox-guard';
export const inject = ['agents'];

/**
 * Fold agent/inbox/spliced events the same way the inbox projection does.
 * Throws when a splice is not a legal inbox transition, so the caller can
 * fail open instead of cancelling against a fold it does not trust.
 *
 * @param {readonly { type?: string, data?: { target?: string, start?: number, removedCount?: number, inserted?: unknown[] } }[]} events
 * @returns {{ 'next-turn': unknown[], 'next-step': unknown[] }}
 */
export function foldInbox(events) {
  /** @type {{ 'next-turn': unknown[], 'next-step': unknown[] }} */
  const state = { 'next-turn': [], 'next-step': [] };
  for (const event of events) {
    if (!event || event.type !== 'agent/inbox/spliced') continue;
    const splice = event.data;
    if (!splice || (splice.target !== 'next-turn' && splice.target !== 'next-step')) {
      throw new Error('invalid inbox splice');
    }
    const inbox = state[splice.target];
    const removedCount = splice.removedCount ?? 0;
    const start = splice.start;
    const inserted = splice.inserted;
    if (!Number.isSafeInteger(start) || start < 0 || start > inbox.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0
      || start + removedCount > inbox.length
      || !Array.isArray(inserted)) {
      throw new Error('invalid inbox splice');
    }
    const next = inbox.toSpliced(start, removedCount, ...inserted);
    const ids = new Set();
    const combined = splice.target === 'next-turn'
      ? [...next, ...state['next-step']]
      : [...state['next-turn'], ...next];
    for (const message of combined) {
      const id = messageId(message);
      if (id === undefined) throw new Error('invalid inbox splice');
      if (ids.has(id)) throw new Error(`message "${id}" is already pending`);
      ids.add(id);
    }
    state[splice.target] = next;
  }
  return state;
}

/**
 * Pending ids that the inherited prefix still explains and the live inbox holds.
 * Live order is preserved. Throws when the prefix fold is not trustworthy.
 *
 * @param {readonly unknown[]} prefixEvents
 * @param {readonly unknown[] | undefined} nextTurn
 * @param {readonly unknown[] | undefined} nextStep
 * @returns {string[]}
 */
export function selectInheritedPending(prefixEvents, nextTurn, nextStep) {
  const folded = foldInbox(prefixEvents);
  const inherited = new Set([
    ...messageIds(folded['next-turn']),
    ...messageIds(folded['next-step']),
  ]);
  return [...messageIds(nextTurn), ...messageIds(nextStep)].filter((id) => inherited.has(id));
}

/**
 * Cancel inherited pending input on one agent.
 * Returns how many items were removed. Returns 0 without touching the inbox
 * when the session is unseeded, the prefix cannot be read, or the fold fails.
 *
 * @param {{ session?: { id?: string, inheritedEventCount?: number, snapshotEvents?: Function }, inbox?: { nextTurn?: readonly unknown[], nextStep?: readonly unknown[], remove?: Function } } | undefined} agent
 * @param {(level: 'info' | 'warn', message: string) => void} [log]
 * @returns {number}
 */
export function dropInheritedInbox(agent, log = () => {}) {
  const session = agent?.session;
  const inbox = agent?.inbox;
  const cut = Number(session?.inheritedEventCount ?? 0);
  if (!Number.isSafeInteger(cut) || cut <= 0 || !inbox || typeof inbox.remove !== 'function') return 0;
  if (typeof session.snapshotEvents !== 'function') {
    log('warn', `session ${session.id ?? '?'}: cannot read the inherited prefix; left its queue untouched`);
    return 0;
  }

  /** @type {readonly unknown[]} */
  let prefix;
  try {
    prefix = session.snapshotEvents(0, cut);
  } catch (error) {
    log('warn', `session ${session.id ?? '?'}: failed to read the inherited prefix (${errorText(error)}); left its queue untouched`);
    return 0;
  }
  if (!Array.isArray(prefix)) {
    log('warn', `session ${session.id ?? '?'}: inherited prefix was not a list; left its queue untouched`);
    return 0;
  }

  /** @type {string[]} */
  let doomed;
  try {
    doomed = selectInheritedPending(prefix, inbox.nextTurn, inbox.nextStep);
  } catch (error) {
    log('warn', `session ${session.id ?? '?'}: inherited inbox fold failed (${errorText(error)}); left its queue untouched`);
    return 0;
  }

  let dropped = 0;
  for (const id of doomed) {
    try {
      if (inbox.remove(id) === false) continue;
      dropped += 1;
    } catch (error) {
      log('warn', `session ${session.id ?? '?'}: failed while cancelling inherited prompt ${id} (${errorText(error)})`);
      break;
    }
  }
  if (dropped > 0) {
    log('info', `[dsh-fork-inbox-guard] ${session.id ?? '?'}: dropped ${dropped} inherited prompt(s)`);
  }
  return dropped;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /**
   * @param {'info' | 'warn'} level
   * @param {string} message
   */
  const log = (level, message) => {
    const line = message.startsWith('[dsh-fork-inbox-guard]')
      ? message
      : `[dsh-fork-inbox-guard] ${message}`;
    const logger = ctx?.logger;
    if (logger && typeof logger[level] === 'function') logger[level](line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  };

  /**
   * @param {Parameters<typeof dropInheritedInbox>[0]} agent
   */
  const sweep = (agent) => {
    try {
      dropInheritedInbox(agent, log);
    } catch (error) {
      log('warn', `sweep failed: ${errorText(error)}`);
    }
  };

  try {
    if (typeof ctx.agents?.list === 'function') {
      for (const agent of ctx.agents.list()) sweep(agent);
    }
  } catch (error) {
    log('warn', `could not sweep live agents: ${errorText(error)}`);
  }

  ctx.on('agent/created', ({ agent }) => {
    sweep(agent);
  });
}

/**
 * @param {unknown} message
 * @returns {string | undefined}
 */
function messageId(message) {
  if (!message || typeof message !== 'object') return undefined;
  const id = /** @type {{ id?: unknown }} */ (message).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * @param {readonly unknown[] | undefined} messages
 * @returns {string[]}
 */
function messageIds(messages) {
  if (!messages) return [];
  /** @type {string[]} */
  const ids = [];
  for (const message of messages) {
    const id = messageId(message);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
