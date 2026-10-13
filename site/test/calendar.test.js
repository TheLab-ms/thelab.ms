import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR_FEED, calendarData, calendarRange, expandCalendar } from '../src/calendar.js';
import worker from '../src/index.js';

const zone = `BEGIN:VTIMEZONE
TZID:America/Chicago
BEGIN:DAYLIGHT
DTSTART:19700308T020000
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
DTSTART:19701101T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;
const event = (lines, uid = 'tour') => `BEGIN:VEVENT\nUID:${uid}\n${lines}\nEND:VEVENT`;
const feed = (...events) => `BEGIN:VCALENDAR\nVERSION:2.0\n${zone}\n${events.join('\n')}\nEND:VCALENDAR`;
const weekly = event('DTSTART;TZID=America/Chicago:20260106T190000\nDTEND;TZID=America/Chicago:20260106T210000\nRRULE:FREQ=WEEKLY;BYDAY=TU\nSUMMARY:Open House & Tours');
afterEach(() => vi.restoreAllMocks());

describe('calendar recurrence', () => {
	it('preserves Central wall time across DST and supplies a six-week grid', () => {
		const data = expandCalendar(feed(weekly), '2026-03');
		expect(data.gridStart).toBe('2026-03-01');
		expect(data.gridEnd).toBe('2026-04-12');
		expect(data.events.find(e => e.start.startsWith('2026-03-04')).start).toBe('2026-03-04T01:00:00.000Z');
		expect(data.events.find(e => e.start.startsWith('2026-03-11')).start).toBe('2026-03-11T00:00:00.000Z');
	});
	it('handles EXDATE, moved and cancelled exceptions without mixing series', () => {
		const data = expandCalendar(feed(
			weekly.replace('SUMMARY:', 'EXDATE;TZID=America/Chicago:20260317T190000\nSUMMARY:'),
			event('RECURRENCE-ID;TZID=America/Chicago:20260310T190000\nDTSTART;TZID=America/Chicago:20260312T180000\nDTEND;TZID=America/Chicago:20260312T200000\nSUMMARY:Moved tour'),
			event('RECURRENCE-ID;TZID=America/Chicago:20260324T190000\nDTSTART;TZID=America/Chicago:20260324T190000\nDTEND;TZID=America/Chicago:20260324T210000\nSTATUS:CANCELLED'),
			event('DTSTART;TZID=America/Chicago:20260106T190000\nDTEND;TZID=America/Chicago:20260106T210000\nRRULE:FREQ=WEEKLY;BYDAY=TU\nSUMMARY:Other series', 'other'),
		), '2026-03');
		expect(data.events.filter(e => e.title === 'Moved tour')).toHaveLength(1);
		expect(data.events.filter(e => e.title === 'Other series')).toHaveLength(6);
		expect(data.events.filter(e => e.title === 'Open House & Tours')).toHaveLength(3);
	});
	it('includes exceptions moved in from outside the visible grid', () => {
		const data = expandCalendar(feed(weekly, event('RECURRENCE-ID;TZID=America/Chicago:20260707T190000\nDTSTART;TZID=America/Chicago:20260312T180000\nDTEND;TZID=America/Chicago:20260312T200000\nSUMMARY:Moved from July')), '2026-03');
		expect(data.events.filter(e => e.title === 'Moved from July')).toHaveLength(1);
	});
	it('keeps all-day exclusive end dates, spanning events, folded text, and floating time', () => {
		const data = expandCalendar(feed(
			event('DTSTART;VALUE=DATE:20260228\nDTEND;VALUE=DATE:20260303\nSUMMARY:Maker weekend', 'weekend'),
			event('DTSTART:20260302T190000\nDTEND:20260302T200000\nSUMMARY:Long title\n continued\nDESCRIPTION:Hello\\, makers!\\nBring tools.', 'floating'),
			event('DTSTART:20260228T230000Z\nDTEND:20260301T090000Z\nSUMMARY:Overnight', 'overnight'),
		), '2026-03');
		expect(data.events.find(e => e.allDay)).toMatchObject({ start: '2026-02-28', end: '2026-03-03' });
		expect(data.events.find(e => e.id.startsWith('floating/'))).toMatchObject({ start: '2026-03-03T01:00:00.000Z', title: 'Long titlecontinued', description: 'Hello, makers!\nBring tools.' });
		expect(data.events).toHaveLength(3);
	});
	it('rejects malformed feeds and limits recurrence processing', () => {
		expect(() => expandCalendar('invalid', '2026-03')).toThrow();
		expect(() => expandCalendar(feed(event('DTSTART;TZID=America/Chicago:20260101T000000\nRRULE:FREQ=SECONDLY\nSUMMARY:Too many')), '2026-03')).toThrow(/limit/);
	});
	it('uses Central month boundaries and allows previous through next twelve months', () => {
		expect(calendarRange(new Date('2026-11-01T02:00:00Z'))).toEqual({ current: '2026-10', min: '2026-09', max: '2027-10' });
	});
});

describe('cached public calendar', () => {
	let fetchSpy;
	const request = query => new Request(`${env.SITE_URL}/calendar/data${query || ''}`);
	beforeEach(async () => {
		await reset();
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(feed(weekly)));
	});
	it('routes publicly and reuses normalized month and shared feed caches', async () => {
		const current = calendarRange().current;
		const first = await worker.fetch(request(`?month=${current}&unused=123`), env);
		expect(first.status).toBe(200);
		expect(first.headers.get('Cache-Control')).toMatch(/s-maxage=/);
		expect((await first.json()).events.length).toBeGreaterThan(0);
		await calendarData(request(`?month=${current}`));
		const next = new Date(`${current}-01T12:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
		await calendarData(request(`?month=${next.toISOString().slice(0, 7)}`));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0][0]).toBe(CALENDAR_FEED);
	});
	it('rejects invalid/out-of-range months and non-GET requests without fetching', async () => {
		for (const month of ['2026-13', '2000-01', '9999-12', 'junk']) expect((await calendarData(request(`?month=${month}`))).status).toBe(400);
		expect((await worker.fetch(new Request(`${env.SITE_URL}/calendar/data`, { method: 'POST' }), env)).status).toBe(405);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
	it('serves last-successful feed during outages and invalid upstream responses', async () => {
		const key = new Request(`${env.SITE_URL}/calendar/cache/feed-v1`);
		await caches.default.put(key, Response.json({ text: feed(weekly), updated: new Date(Date.now() - 700000).toISOString() }, { headers: { 'Cache-Control': 'public, max-age=86400' } }));
		for (const value of [new Response(null, { status: 503 }), new Response('broken')]) {
			fetchSpy.mockResolvedValueOnce(value);
			const response = await calendarData(request());
			expect(response.status).toBe(200);
			expect(response.headers.get('Cache-Control')).toBe('no-store');
			expect((await response.json()).stale).toBe(true);
		}
	});
	it('returns JSON failure without cached data and refuses an expired fallback', async () => {
		fetchSpy.mockRejectedValue(new Error('offline'));
		expect((await calendarData(request())).status).toBe(503);
		await caches.default.put(new Request(`${env.SITE_URL}/calendar/cache/feed-v1`), Response.json({ text: feed(weekly), updated: new Date(Date.now() - 90000000).toISOString() }, { headers: { 'Cache-Control': 'public, max-age=86400' } }));
		expect((await calendarData(request())).status).toBe(503);
	});
});
