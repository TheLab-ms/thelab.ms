import ICAL from 'ical.js';

export const CALENDAR_ID = 'c_abee0e8a8cc80a68542127e93f8009413b06eb0f7cb95aa534dc49d5963394b5@group.calendar.google.com';
export const CALENDAR_FEED = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CALENDAR_ID)}/public/basic.ics`;
const ZONE = 'America/Chicago';
const TTL = 600;
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export const centralDate = date => dateFormat.format(date);
const monthIndex = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;

export function calendarRange(now = new Date()) {
	const current = centralDate(now).slice(0, 7);
	const shift = n => {
		const date = new Date(Date.UTC(Number(current.slice(0, 4)), Number(current.slice(5)) - 1 + n, 1));
		return date.toISOString().slice(0, 7);
	};
	return { current, min: shift(-1), max: shift(12) };
}

export function expandCalendar(text, month) {
	const component = new ICAL.Component(ICAL.parse(text));
	if (component.name !== 'vcalendar' || !component.hasProperty('version')) throw new Error('Invalid calendar feed.');
	const zone = component.getTimeZoneByID(ZONE);
	if (!zone) throw new Error('Calendar timezone missing.');
	const first = new Date(`${month}-01T00:00:00Z`);
	const gridStart = new Date(first);
	gridStart.setUTCDate(1 - first.getUTCDay());
	const gridEnd = new Date(gridStart);
	gridEnd.setUTCDate(gridEnd.getUTCDate() + 42);
	const boundary = date => ICAL.Time.fromData({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0, second: 0 }, zone).toJSDate();
	const start = boundary(gridStart), end = boundary(gridEnd);
	const events = [], seen = new Set();
	let steps = 0;
	function add(item, occurrenceStart, occurrenceEnd, recurrenceId) {
		if (item.component.getFirstPropertyValue('status') === 'CANCELLED') return;
		// Floating times in this calendar use the calendar's declared timezone.
		const toDate = time => {
			const copy = time.clone();
			if (copy.zone === ICAL.Timezone.localTimezone || copy.isDate) copy.zone = zone;
			return copy.toJSDate();
		};
		const from = toDate(occurrenceStart), to = toDate(occurrenceEnd);
		if (from >= end || (to > from ? to <= start : from < start)) return;
		const id = `${item.uid}/${recurrenceId.toString()}`;
		if (seen.has(id)) return;
		seen.add(id);
		if (events.length >= 1000) throw new Error('Calendar event limit exceeded.');
		events.push({ id, title: (item.summary || 'Untitled event').slice(0, 300), description: (item.description || '').slice(0, 10000), location: (item.location || '').slice(0, 1000), start: occurrenceStart.isDate ? occurrenceStart.toString() : from.toISOString(), end: occurrenceEnd.isDate ? occurrenceEnd.toString() : to.toISOString(), allDay: occurrenceStart.isDate });
	}
	const items = component.getAllSubcomponents('vevent').map(value => new ICAL.Event(value, { exceptions: [] }));
	const masters = new Map(items.filter(item => !item.isRecurrenceException()).map(item => [item.uid, item]));
	for (const item of items.filter(item => item.isRecurrenceException())) masters.get(item.uid)?.relateException(item);
	for (const item of items) {
		if (item.isRecurrenceException()) continue;
		if (item.component.getFirstPropertyValue('status') === 'CANCELLED') continue;
		if (!item.startDate) throw new Error('Event start missing.');
		if (!item.isRecurring()) {
			add(item, item.startDate, item.endDate, item.startDate);
			continue;
		}
		const iterator = item.iterator();
		let next;
		while ((next = iterator.next())) {
			if (++steps > 50000) throw new Error('Calendar recurrence limit exceeded.');
			if (next.toJSDate().getTime() > end.getTime() + 86400000) break;
			const details = item.getOccurrenceDetails(next);
			add(details.item, details.startDate, details.endDate, next);
		}
	}
	// Include moved exceptions even when their original date is outside this grid.
	for (const item of items.filter(item => item.isRecurrenceException())) {
		if (masters.get(item.uid)?.component.getFirstPropertyValue('status') === 'CANCELLED') continue;
		add(item, item.startDate, item.endDate, item.recurrenceId);
	}
	events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
	return { events, gridStart: gridStart.toISOString().slice(0, 10), gridEnd: gridEnd.toISOString().slice(0, 10) };
}

export async function calendarData(request) {
	const url = new URL(request.url), range = calendarRange();
	const month = url.searchParams.get('month') || range.current;
	const response = (body, status = 200, ttl = 0) => Response.json(body, { status, headers: { 'Cache-Control': ttl ? `public, max-age=0, s-maxage=${ttl}` : 'no-store', 'X-Content-Type-Options': 'nosniff' } });
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || monthIndex(month) < monthIndex(range.min) || monthIndex(month) > monthIndex(range.max)) return response({ error: 'Choose a month within the available calendar range.' }, 400);
	const cache = caches.default;
	const key = new Request(`${url.origin}/calendar/data?month=${month}&v=1`);
	const hit = await cache.match(key);
	if (hit) {
		const data = await hit.json();
		return response({ ...data, ...range }, 200, Math.max(1, Math.floor(TTL - (Date.now() - new Date(data.updated).getTime()) / 1000)));
	}
	const feedKey = new Request(`${url.origin}/calendar/cache/feed-v1`);
	const saved = await cache.match(feedKey);
	let feed = saved ? await saved.json() : null, stale = false;
	const age = () => feed ? (Date.now() - new Date(feed.updated).getTime()) / 1000 : Infinity;
	let expanded;
	try {
		if (age() >= TTL) {
			const upstream = await fetch(CALENDAR_FEED, { signal: AbortSignal.timeout(8000), redirect: 'error' });
			if (!upstream.ok) throw new Error('Calendar feed unavailable.');
			const reader = upstream.body.getReader(), chunks = [];
			let size = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Calendar feed too large.'); }
				chunks.push(value);
			}
			const text = await new Blob(chunks).text();
			expanded = expandCalendar(text, month);
			feed = { text, updated: new Date().toISOString() };
			await cache.put(feedKey, Response.json(feed, { headers: { 'Cache-Control': 'public, max-age=86400' } }));
		} else expanded = expandCalendar(feed.text, month);
	} catch {
		if (age() >= 86400) return response({ error: 'Events are temporarily unavailable. Please try again.' }, 503);
		try { expanded = expandCalendar(feed.text, month); stale = true; }
		catch { return response({ error: 'Events are temporarily unavailable. Please try again.' }, 503); }
	}
	const data = { ...expanded, month, ...range, timeZone: ZONE, updated: feed.updated, stale };
	if (!stale) {
		const remaining = Math.max(1, Math.floor(TTL - age()));
		await cache.put(key, Response.json(data, { headers: { 'Cache-Control': `public, max-age=${remaining}` } }));
		return response(data, 200, remaining);
	}
	return response(data);
}
