import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseLocate } from '../src/agent/pointer.mjs';
import { createSchedule, localNow, validDateTime } from '../src/assistant/schedule.mjs';
import { CARD_H, CARD_W, pointerToRgba } from '../src/bridge/media.mjs';
import { createToolHandlers } from '../src/tools/handlers.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-sched-')), 'schedule.json');
const fixedNow = () => new Date('2026-11-15T15:00:00Z');

test('schedule: store and retrieve, sorted, filtered by date', () => {
  const file = tmpFile();
  const s = createSchedule(file, { tz: 'America/Chicago', now: fixedNow });
  assert.equal(s.add({ title: 'Dentist', start: '2026-11-17T15:00', end: '2026-11-17T16:00' }).ok, true);
  assert.equal(s.add({ title: 'Return the router', start: '2026-11-16T09:30', notes: 'receipt in drawer' }).ok, true);
  assert.equal(s.add({ title: 'Past thing', start: '2026-11-10T09:00' }).ok, true);

  const upcoming = s.list();
  assert.equal(upcoming.from_date, '2026-11-15'); // today in Chicago
  assert.deepEqual(upcoming.events.map((e) => e.title), ['Return the router', 'Dentist']);
  assert.deepEqual(s.list({ from_date: '2026-11-17', to_date: '2026-11-17' }).events.map((e) => e.title), ['Dentist']);

  // persisted: a new instance (next call) reads the same file
  assert.equal(createSchedule(file, { now: fixedNow }).list({ from_date: '2026-11-01' }).total, 3);
});

test('schedule: rejects bad input', () => {
  const s = createSchedule(tmpFile(), { now: fixedNow });
  assert.equal(s.add({ title: '', start: '2026-11-17T15:00' }).ok, false);
  assert.equal(s.add({ title: 'x', start: 'Tuesday 3pm' }).ok, false);
  assert.equal(s.add({ title: 'x', start: '2026-02-30T10:00' }).ok, false);
  assert.equal(s.add({ title: 'x', start: '2026-11-17T15:00', end: '2026-11-17T14:00' }).ok, false);
  assert.equal(s.list({ from_date: 'next week' }).ok, false);
  assert.equal(validDateTime('2026-11-17T24:00'), false);
  assert.match(localNow('UTC', fixedNow()).date, /^2026-11-15$/);
});

const handlersWith = (opts) => createToolHandlers({
  sessionId: 's1', callerId: 'c_test', guideVersion: 1,
  paths: { sessions: path.join(os.tmpdir(), 'unused-sessions.jsonl') },
  mirror: { record() {} },
  schedule: createSchedule(tmpFile(), { now: fixedNow }),
  ...opts,
});

test('schedule tools need no logging consent, and a PIN locks them per call', async () => {
  const open = handlersWith({ schedulePin: '' });
  assert.equal((await open.dispatch('add_event', { title: 'Gym', start: '2026-11-18T07:00' })).ok, true);

  const { dispatch } = handlersWith({ schedulePin: '4321' });
  const locked = await dispatch('list_events', {});
  assert.equal(locked.ok, false);
  assert.equal(locked.locked, true);
  assert.equal((await dispatch('unlock_schedule', { pin: '1111' })).ok, false);
  assert.equal((await dispatch('unlock_schedule', { pin: '4 3 2 1' })).ok, true); // spoken digits
  assert.equal((await dispatch('add_event', { title: 'Gym', start: '2026-11-18T07:00' })).ok, true);
  assert.equal((await dispatch('list_events', { from_date: '2026-11-18' })).total, 1);
});

test('schedule PIN: 3 wrong tries lock the schedule for the call', async () => {
  const { dispatch } = handlersWith({ schedulePin: '4321' });
  for (let i = 0; i < 3; i++) await dispatch('unlock_schedule', { pin: '0000' });
  assert.equal((await dispatch('unlock_schedule', { pin: '4321' })).ok, false);
});

test('point_at: falls back to words when the transport cannot show images', async () => {
  const { dispatch } = handlersWith({});
  assert.match((await dispatch('point_at', { target: 'HDMI 1' })).error, /not available/);
  const calls = [];
  const withPointer = handlersWith({ pointAt: async (a) => { calls.push(a); return { ok: true }; } });
  assert.equal((await withPointer.dispatch('point_at', { target: ' the HDMI 1 port ', label: 'HDMI 1' })).ok, true);
  assert.deepEqual(calls, [{ target: 'the HDMI 1 port', label: 'HDMI 1' }]);
  assert.equal((await withPointer.dispatch('point_at', {})).ok, false);
});

test('point_at: parses both reply shapes and rejects junk boxes', () => {
  assert.deepEqual(parseLocate({ found: true, box_2d: [476, 261, 548, 378], label: 'HDMI 1' }), { found: true, box: [476, 261, 548, 378], label: 'HDMI 1' });
  assert.equal(parseLocate([{ box_2d: [477, 263, 547, 377], label: 'port' }]).found, true); // list, no "found"
  assert.equal(parseLocate({ found: false }).found, false);
  assert.equal(parseLocate({ found: true, box_2d: [10, 10, 11, 11] }).found, false); // too small
  assert.equal(parseLocate({ found: true, box_2d: ['a', 1, 2, 3] }).found, false);
  assert.deepEqual(parseLocate({ found: true, box_2d: [-50, 0, 1200, 500] }).box, [0, 0, 1000, 500]);
});

test('point_at: draws the circled snapshot at card size', async () => {
  const jpeg = fs.readFileSync(new URL('./fixtures/monitor-wrong-port.jpg', import.meta.url));
  const px = await pointerToRgba(jpeg, [476, 261, 548, 378], 'HDMI <1>');
  assert.equal(px.length, CARD_W * CARD_H * 4);
});
