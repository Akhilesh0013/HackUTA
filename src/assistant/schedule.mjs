// Personal schedule: store and retrieve only. One schedule per line owner (Chert does not tell the
// agent who is calling yet), kept apart from the training logs: never read by curation, never mirrored.
// Times are local wall-clock times ("YYYY-MM-DDTHH:MM") in the assistant's time zone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ASSISTANT_TZ = process.env.ASSISTANT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EVENTS = 500;

/** "2026-11-17T15:00" -> true if it's a real calendar date and time. */
export function validDateTime(s) {
  const m = DATETIME.exec(String(s ?? ''));
  if (!m) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && h < 24 && mi < 60;
}

/** Local date and time parts in a time zone, e.g. { date: '2026-11-15', time: '09:40', text: 'Sunday, November 15, 2026, 9:40 AM' }. */
export function localNow(tz = ASSISTANT_TZ, at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const text = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(at);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, text, tz };
}

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.events) ? data : { events: [] };
  } catch {
    return { events: [] };
  }
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic replace: a crash never leaves half a file
}

const clean = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

export function createSchedule(file, { tz = ASSISTANT_TZ, now = () => new Date() } = {}) {
  return {
    add({ title, start, end, notes } = {}) {
      const t = clean(title, 100);
      const errs = [];
      if (!t) errs.push('title required');
      if (!validDateTime(start)) errs.push('start must be YYYY-MM-DDTHH:MM (local time)');
      if (end != null && end !== '' && !validDateTime(end)) errs.push('end must be YYYY-MM-DDTHH:MM (local time)');
      if (!errs.length && end && end < start) errs.push('end is before start');
      if (errs.length) return { ok: false, error: errs.join('; ') };
      const data = load(file);
      if (data.events.length >= MAX_EVENTS) return { ok: false, error: `schedule is full (${MAX_EVENTS} events)` };
      const event = {
        id: `ev_${crypto.randomBytes(4).toString('hex')}`,
        title: t,
        start,
        ...(end ? { end } : {}),
        ...(notes ? { notes: clean(notes, 300) } : {}),
        tz,
        created_at: now().toISOString(),
      };
      data.events.push(event);
      save(file, data);
      return { ok: true, event };
    },

    /** Events whose start date is in [from_date, to_date]. Defaults: from today, no end, first `limit`. */
    list({ from_date, to_date, limit = 20 } = {}) {
      if (from_date && !DATE.test(from_date)) return { ok: false, error: 'from_date must be YYYY-MM-DD' };
      if (to_date && !DATE.test(to_date)) return { ok: false, error: 'to_date must be YYYY-MM-DD' };
      const from = from_date || localNow(tz, now()).date;
      const n = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 20));
      const matching = load(file).events
        .filter((e) => e.start.slice(0, 10) >= from && (!to_date || e.start.slice(0, 10) <= to_date))
        .sort((a, b) => a.start.localeCompare(b.start));
      return { ok: true, from_date: from, to_date: to_date || null, total: matching.length, events: matching.slice(0, n) };
    },
  };
}
