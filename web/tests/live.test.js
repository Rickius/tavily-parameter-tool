// The rules behind the live output window: what to say when a pane is quiet, and how much text to keep.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { agoText, capText, FIRST_OUTPUT_HINT_AFTER, hintFor, MAX_CHARS, SILENCE_HINT_AFTER, STAGE_TITLE, STATUS_LABEL } from '../live.js';

const sec = (n) => n * 1000;

describe('hintFor', () => {
  const receiving = (lastOutputAt) => ({ status: 'receiving', attemptStartedAt: 0, lastOutputAt });

  test('says nothing while output is flowing', () => {
    assert.equal(hintFor(receiving(sec(10)), sec(12)), '');
    assert.equal(hintFor(receiving(0), sec(SILENCE_HINT_AFTER - 1)), '');
  });

  test('after 30 seconds of silence it says how long and that waiting is normal', () => {
    assert.equal(hintFor(receiving(0), sec(30)), 'No new output for 30 s. Reasoning models can pause; still waiting.');
    assert.equal(hintFor(receiving(sec(5)), sec(52)), 'No new output for 47 s. Reasoning models can pause; still waiting.');
  });

  test('before any output it waits 60 seconds, then says it is still waiting', () => {
    const waiting = { status: 'waiting', attemptStartedAt: 0, lastOutputAt: null };
    assert.equal(hintFor(waiting, sec(FIRST_OUTPUT_HINT_AFTER - 1)), '');
    assert.equal(hintFor(waiting, sec(60)), 'Still waiting for the first output.');
  });

  test('a retry counts its 60 seconds from when it was asked again', () => {
    const retry = { status: 'retry', attemptStartedAt: sec(100), lastOutputAt: sec(90) };
    assert.equal(hintFor(retry, sec(150)), '');
    assert.equal(hintFor(retry, sec(160)), 'Still waiting for the first output.');
  });

  test('finished panes never show a hint', () => {
    for (const status of ['done', 'failed']) assert.equal(hintFor({ status, attemptStartedAt: 0, lastOutputAt: 0 }, sec(500)), '');
  });
});

describe('capText', () => {
  test('keeps short text whole', () => assert.deepEqual(capText('hello', 10), { text: 'hello', hidden: 0 }));

  test('keeps the most recent characters and counts the rest', () => {
    const { text, hidden } = capText('0123456789', 4);
    assert.deepEqual({ text, hidden }, { text: '6789', hidden: 6 });
  });

  test('uses 30,000 characters by default', () => {
    const { text, hidden } = capText('x'.repeat(MAX_CHARS + 123));
    assert.equal(text.length, MAX_CHARS);
    assert.equal(hidden, 123);
  });

  test('does not start in the middle of an emoji', () => {
    const { text } = capText('ab🛒cd', 3); // keeping 3 would start inside the 🛒 pair
    assert.doesNotMatch(text, /^[\udc00-\udfff]/);
    assert.equal(text, 'cd');
  });
});

describe('labels', () => {
  test('agoText', () => {
    assert.equal(agoText(0.4), 'last output just now');
    assert.equal(agoText(1.9), 'last output just now');
    assert.equal(agoText(7.8), 'last output 7s ago');
  });

  test('every status has a label and every stage a title', () => {
    assert.deepEqual(Object.values(STATUS_LABEL), ['Waiting for first output', 'Receiving', 'Asking again', 'Done', 'Failed']);
    assert.deepEqual(Object.keys(STAGE_TITLE), ['planner', 'planner1', 'planner2', 'aggregator']);
  });
});
