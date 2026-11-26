import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, dropInheritedInbox, foldInbox, selectInheritedPending } from '../index.js';

function message(id) {
  return { id, content: [{ type: 'text', text: id }] };
}

function splice(target, start, inserted, removedCount) {
  return {
    type: 'agent/inbox/spliced',
    data: {
      target,
      start,
      ...(removedCount === undefined ? {} : { removedCount }),
      inserted,
    },
  };
}

function inboxFrom(nextTurn, nextStep = []) {
  const state = {
    'next-turn': [...nextTurn],
    'next-step': [...nextStep],
  };
  return {
    get nextTurn() { return state['next-turn']; },
    get nextStep() { return state['next-step']; },
    remove(id) {
      for (const target of ['next-turn', 'next-step']) {
        const index = state[target].findIndex((item) => item.id === id);
        if (index < 0) continue;
        state[target].splice(index, 1);
        return true;
      }
      return false;
    },
  };
}

test('a prefix that only inserts leaves those prompts pending', () => {
  const folded = foldInbox([
    splice('next-turn', 0, [message('parent-a')]),
    splice('next-turn', 1, [message('parent-b')]),
    splice('next-step', 0, [message('steer')]),
  ]);
  assert.deepEqual(folded['next-turn'].map((item) => item.id), ['parent-a', 'parent-b']);
  assert.deepEqual(folded['next-step'].map((item) => item.id), ['steer']);
});

test('an insert consumed inside the prefix is not pending', () => {
  const folded = foldInbox([
    splice('next-turn', 0, [message('parent-a')]),
    splice('next-turn', 0, [], 1),
  ]);
  assert.deepEqual(folded['next-turn'], []);
});

test('selection keeps the child prompt and drops only the inherited ones', () => {
  const prefix = [
    splice('next-turn', 0, [message('parent-a')]),
    splice('next-step', 0, [message('steer')]),
  ];
  const selected = selectInheritedPending(
    prefix,
    [message('parent-a'), message('child')],
    [message('steer'), message('child-step')],
  );
  assert.deepEqual(selected, ['parent-a', 'steer']);
});

test('an item with no traceable origin is kept', () => {
  const selected = selectInheritedPending(
    [],
    [message('mystery')],
    [],
  );
  assert.deepEqual(selected, []);
});

test('an invalid splice is rejected instead of guessed', () => {
  assert.throws(
    () => foldInbox([splice('next-turn', 3, [message('orphan')])]),
    /invalid inbox splice/,
  );
});

test('drop cancels inherited prompts and leaves the child queue', () => {
  const inbox = inboxFrom([message('parent-a'), message('child')], [message('steer')]);
  const session = {
    id: 'session-child',
    inheritedEventCount: 2,
    snapshotEvents(from, to) {
      assert.deepEqual([from, to], [0, 2]);
      return [
        splice('next-turn', 0, [message('parent-a')]),
        splice('next-step', 0, [message('steer')]),
      ].slice(from, to);
    },
  };
  const notes = [];
  const dropped = dropInheritedInbox({ session, inbox }, (level, messageText) => {
    notes.push([level, messageText]);
  });
  assert.equal(dropped, 2);
  assert.deepEqual(inbox.nextTurn.map((item) => item.id), ['child']);
  assert.deepEqual(inbox.nextStep, []);
  assert.match(notes[0][1], /dropped 2 inherited prompt/);
});

test('an unseeded session is never touched', () => {
  const inbox = inboxFrom([message('own')]);
  const dropped = dropInheritedInbox({
    session: {
      id: 'session-plain',
      inheritedEventCount: 0,
      snapshotEvents() {
        throw new Error('should not read');
      },
    },
    inbox,
  });
  assert.equal(dropped, 0);
  assert.deepEqual(inbox.nextTurn.map((item) => item.id), ['own']);
});

test('a second pass is a no-op after the inherited prompts are gone', () => {
  const prefix = [splice('next-turn', 0, [message('parent-a')])];
  const session = {
    id: 'session-child',
    inheritedEventCount: 1,
    snapshotEvents: () => prefix,
  };
  const inbox = inboxFrom([message('parent-a'), message('child')]);
  assert.equal(dropInheritedInbox({ session, inbox }), 1);
  assert.equal(dropInheritedInbox({ session, inbox }), 0);
  assert.deepEqual(inbox.nextTurn.map((item) => item.id), ['child']);
});

test('a fold failure leaves the live queue untouched', () => {
  const inbox = inboxFrom([message('parent-a')]);
  const notes = [];
  const dropped = dropInheritedInbox({
    session: {
      id: 'session-bad',
      inheritedEventCount: 1,
      snapshotEvents: () => [splice('next-turn', 4, [message('parent-a')])],
    },
    inbox,
  }, (level, messageText) => notes.push([level, messageText]));
  assert.equal(dropped, 0);
  assert.deepEqual(inbox.nextTurn.map((item) => item.id), ['parent-a']);
  assert.equal(notes[0][0], 'warn');
});

test('apply sweeps live agents and later forks, and a listener failure does not escape', () => {
  const swept = [];
  const listeners = [];
  const parent = splice('next-turn', 0, [message('parent-a')]);
  const liveInbox = inboxFrom([message('parent-a')]);
  const ctx = {
    logger: {
      info() {},
      warn(line) { swept.push(line); },
    },
    agents: {
      list() {
        return [{
          session: {
            id: 'session-live',
            inheritedEventCount: 1,
            snapshotEvents: () => [parent],
          },
          inbox: liveInbox,
        }];
      },
    },
    on(event, listener) {
      assert.equal(event, 'agent/created');
      listeners.push(listener);
    },
  };
  apply(ctx);
  assert.deepEqual(liveInbox.nextTurn, []);

  const createdInbox = inboxFrom([message('parent-b'), message('child')]);
  listeners[0]({
    agent: {
      session: {
        id: 'session-created',
        inheritedEventCount: 1,
        snapshotEvents: () => [splice('next-turn', 0, [message('parent-b')])],
      },
      inbox: createdInbox,
    },
  });
  assert.deepEqual(createdInbox.nextTurn.map((item) => item.id), ['child']);

  assert.doesNotThrow(() => listeners[0]({ agent: null }));
});
