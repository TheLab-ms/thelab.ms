import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { occurrenceAt, occurrenceCount, occurrencesBetween, readSchedule, repeatLabel, startSeconds, type Schedule } from '../src/recurrence.ts';

const schedule = (fields: Partial<Schedule> = {}): Schedule => ({ title: 'Make night', description: '', location: 'TheLab',
  start: '2027-03-07T19:00', minutes: 120, repeat: 'weekly', interval: 1, count: null, until: '', rsvp: true, capacity: null, cancelled: false, ...fields });
const utc = (value: Schedule) => new Date(startSeconds(value) * 1000).toISOString();

describe('Local-time recurrence', () => {
  beforeEach(() => vi.setSystemTime(new Date('2027-01-01T00:00:00Z')));
  afterEach(() => vi.useRealTimers());

  it('keeps weekly events at 7 PM through spring and fall DST changes', () => {
    const spring = schedule();
    expect(utc(occurrenceAt(spring, 0)!)).toBe('2027-03-08T01:00:00.000Z');
    expect(utc(occurrenceAt(spring, 1)!)).toBe('2027-03-15T00:00:00.000Z');
    const fall = schedule({ start: '2027-10-31T19:00' });
    expect(utc(occurrenceAt(fall, 0)!)).toBe('2027-11-01T00:00:00.000Z');
    expect(utc(occurrenceAt(fall, 1)!)).toBe('2027-11-08T01:00:00.000Z');
  });

  it('shifts nonexistent times forward and chooses the first repeated time', () => {
    expect(utc(occurrenceAt(schedule({ start: '2027-03-07T02:30' }), 1)!)).toBe('2027-03-14T08:30:00.000Z');
    expect(utc(occurrenceAt(schedule({ start: '2027-10-31T01:30' }), 1)!)).toBe('2027-11-07T06:30:00.000Z');
  });

  it('keeps legacy stored date-based schedules readable without changing their occurrences', () => {
    const monthly = schedule({ start: '2027-01-31T19:00', repeat: 'monthly', count: 3 });
    expect([0, 1, 2].map(n => occurrenceAt(monthly, n)?.start)).toEqual(['2027-01-31T19:00', '2027-03-31T19:00', '2027-05-31T19:00']);
    expect(occurrenceAt(monthly, 3)).toBeNull();
    const leap = schedule({ start: '2027-12-29T19:00', repeat: 'monthly' });
    expect(occurrenceAt(leap, 2)?.start).toBe('2028-02-29T19:00');
  });

  it('creates weekly weekday and monthly weekday-position patterns with readable labels', () => {
    const form = { title: 'Make night', location: 'TheLab', minutes: '120' };
    const tuesday = readSchedule({ ...form, start: '2027-01-05T19:00', repeat: 'weekly' });
    expect(repeatLabel(tuesday)).toBe('Every Tuesday');
    expect(occurrenceAt(tuesday, 1)?.start).toBe('2027-01-12T19:00');
    const saturday = readSchedule({ ...form, start: '2027-01-09T19:00', repeat: 'ordinal' });
    expect(saturday.ordinal).toBe(2);
    expect(repeatLabel(saturday)).toBe('The second Saturday of every month');
    expect([0, 1, 2].map(n => occurrenceAt(saturday, n)?.start)).toEqual(['2027-01-09T19:00', '2027-02-13T19:00', '2027-03-13T19:00']);
    const fifth = readSchedule({ ...form, start: '2027-01-30T19:00', repeat: 'ordinal' });
    expect(fifth.ordinal).toBe(-1);
    expect(repeatLabel(fifth)).toBe('The last Saturday of every month');
    expect(occurrenceAt(fifth, 1)?.start).toBe('2027-02-27T19:00');
    const once = readSchedule({ ...form, start: '2027-01-05T19:00', repeat: 'none' });
    expect(repeatLabel(once)).toBe('');
    expect(occurrenceAt(once, 1)).toBeNull();
  });

  it('retains an existing last-weekday pattern until its start date changes, without relying on JavaScript', () => {
    const form = { title: 'Make night', location: 'TheLab', minutes: '120', repeat: 'ordinal', ordinal: '-1', recurrence_start: '2027-02-27T19:00' };
    expect(readSchedule({ ...form, start: '2027-02-27T20:00' }).ordinal).toBe(-1);
    const changed = readSchedule({ ...form, start: '2027-03-13T19:00' });
    expect(changed.ordinal).toBe(2);
    expect(occurrenceAt(changed, 1)?.start).toBe('2027-04-10T19:00');
  });

  it('supports nth/last weekdays, intervals, inclusive end dates, and counts', () => {
    const secondTuesday = schedule({ start: '2027-01-12T19:00', repeat: 'ordinal', interval: 2 });
    expect(occurrenceAt(secondTuesday, 1)?.start).toBe('2027-03-09T19:00');
    const lastSunday = schedule({ start: '2027-01-31T19:00', repeat: 'ordinal' });
    expect(occurrenceAt(lastSunday, 1)?.start).toBe('2027-02-28T19:00');
    const lastSundayInFebruary = schedule({ start: '2027-02-28T19:00', repeat: 'ordinal', ordinal: -1 });
    expect(occurrenceAt(lastSundayInFebruary, 2)?.start).toBe('2027-04-25T19:00');
    const finite = schedule({ until: '2027-03-21' });
    expect(occurrenceCount(finite)).toBe(3);
    expect(occurrenceAt(finite, 2)?.start).toBe('2027-03-21T19:00');
    expect(occurrenceAt(finite, 3)).toBeNull();
  });

  it('includes overnight events crossing a month boundary without timezone drift', () => {
    const overnight = schedule({ start: '2027-03-31T23:00', minutes: 120, repeat: 'none' });
    const items = occurrencesBetween(overnight, Date.parse('2027-04-01T05:00Z') / 1000, Date.parse('2027-05-01T05:00Z') / 1000);
    expect(items).toHaveLength(1);
    expect(items[0]?.offset).toBe(0);
  });

  it('treats event length as elapsed minutes across daylight-saving changes', () => {
    const form = { title: 'Make night', location: 'TheLab', minutes: '120' };
    for (const [start, end] of [['2027-03-14T01:30', '2027-03-14T09:30:00.000Z'], ['2027-11-07T01:30', '2027-11-07T08:30:00.000Z']]) {
      const event = readSchedule({ ...form, start });
      expect(new Date((startSeconds(event) + event.minutes * 60) * 1000).toISOString()).toBe(end);
    }
  });

  it('validates scheduling dates, repeat patterns and limits', () => {
    const form = { title: 'Make night', location: 'TheLab', start: '2027-03-07T19:00', minutes: '120', repeat: 'weekly' };
    expect(readSchedule(form).minutes).toBe(120);
    expect(readSchedule({ ...form, minutes: '1' }).minutes).toBe(1);
    expect(readSchedule({ ...form, minutes: '10080' }).minutes).toBe(10080);
    for (const extra of [{ capacity: '-1' }, { capacity: '2.5' }, { interval: '0' }, { interval: '2' }, { repeat: 'toString' }, { repeat: 'daily' }, { repeat: 'monthly' }, { repeat: 'ordinal', ordinal: '5' },
      { start: '2027-02-30T19:00' }, ...['', '0', '-1', '2.5', '10081', 'NaN', 'Infinity'].map(minutes => ({ minutes })),
      { until: '2026-12-31' }, { count: '3', until: '2027-04-01' }]) {
      expect(() => readSchedule({ ...form, ...extra })).toThrow();
    }
  });
});
