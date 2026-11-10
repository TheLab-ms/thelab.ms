import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEvent, Member } from '../src/lib.ts';
import { call, insertMember, post, quiet, resetDB, session } from './helpers.ts';

const organizerID = '333333333333333333',
	guestID = '555555555555555555',
	otherID = '666666666666666666';
const fields = {
	title: 'Make night',
	description: 'Bring your project.',
	location: 'TheLab',
	start: '2027-03-07T19:00',
	minutes: '120',
	repeat: 'weekly',
	interval: '1',
	rsvp: '1',
	capacity: '',
	until: '',
	count: '',
};
interface Feed {
	events: { url: string; title: string; date: string; start: string; summary: string; cancelled: boolean }[];
}
const feed = async (month = '2027-03') => (await (await call(`/events/data?month=${month}`)).json()) as Feed;
const total = async (id: string, n = 0) =>
	(await env.DB.prepare('SELECT COUNT(*) AS n FROM calendar_rsvps WHERE event_id = ? AND occurrence = ?')
		.bind(id, n)
		.first<{ n: number }>())!.n;

describe('Calendar and event registration', () => {
	let organizer: Member, guest: Member, cookie: string, guestCookie: string;
	beforeEach(async () => {
		await resetDB();
		vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
		quiet();
		organizer = await insertMember({
			discord_user_id: organizerID,
			discord_username: 'organizer',
			non_billable: 1,
		});
		guest = await insertMember({ discord_user_id: guestID, discord_username: 'private-attendee' });
		cookie = await session(organizerID);
		guestCookie = await session(guestID);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function create(extra: Record<string, string> = {}) {
		const response = await call('/events/new', post({ ...fields, ...extra }, { Cookie: cookie }));
		expect(response.status, await response.clone().text()).toBe(303);
		const path = response.headers.get('Location')!;
		return { path, id: path.split('/')[2]! };
	}
	async function edit(id: string, n: number, extra: Record<string, string> = {}, scope = 'one', as = cookie) {
		const event = await env.DB.prepare('SELECT * FROM calendar_events WHERE event_id = ?')
			.bind(id)
			.first<CalendarEvent>();
		return call(
			`/events/${id}/${n}/edit`,
			post({ ...fields, start: '2027-03-08T19:00', scope, revision: event!.revision, ...extra }, { Cookie: as }),
		);
	}
	async function cancel(id: string, n: number) {
		const event = await env.DB.prepare('SELECT * FROM calendar_events WHERE event_id = ?')
			.bind(id)
			.first<CalendarEvent>();
		return call(`/events/${id}/${n}/cancel`, post({ revision: event!.revision }, { Cookie: cookie }));
	}

	it('requires standard active eligibility to publish but exposes the calendar publicly', async () => {
		expect((await call('/events/new')).headers.get('Location')).toContain('/login?next=');
		expect((await call('/events/new', post(fields, { Cookie: guestCookie }))).status).toBe(403);
		await env.DB.prepare(
			"UPDATE members SET stripe_subscription_state = 'active', waiver_signed = 1 WHERE member_id = ?",
		)
			.bind(guest.member_id)
			.run();
		expect((await call('/events/new', post(fields, { Cookie: guestCookie }))).status).toBe(303);
		expect((await feed()).events).toHaveLength(4);
		expect((await call('/events/data?month=2027-03')).headers.get('Cache-Control')).toBe('public, max-age=60');
		const oldPage = await call('/events');
		expect(oldPage.status).toBe(303);
		expect(oldPage.headers.get('Location')).toBe('/#events');
		expect((await call('/events/data?month=garbage')).status).toBe(400);
	});

	it('publishes local-time recurrences and escapes event content', async () => {
		const { path } = await create({ title: '<script>alert(1)</script>', count: '2' });
		const events = (await feed()).events;
		expect(events.map(e => e.start)).toEqual(['2027-03-08T01:00:00.000Z', '2027-03-15T00:00:00.000Z']);
		const html = await (await call(path)).text();
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>alert(1)</script>');
		expect((await call(`${path.replace('/0', '/2')}`)).status).toBe(404);
	});

	it('shortens same-day time ranges but keeps both dates for overnight events', async () => {
		const { path } = await create({ start: '2027-11-09T19:00', minutes: '60', repeat: 'none' });
		const html = await (await call(path)).text();
		expect(html).toContain('November 9, 2027 at 7:00 PM</strong> – 8:00 PM');
		expect(html).not.toContain('November 9, 2027 at 8:00 PM');
		const overnight = await create({ start: '2027-03-31T23:00', repeat: 'none' });
		expect(await (await call(overnight.path)).text()).toContain(
			'March 31, 2027 at 11:00 PM</strong> – April 1, 2027 at 1:00 AM',
		);
	});

	it('renders descriptions as safe Markdown and retains the source when editing', async () => {
		const description =
			'# Make night\n\nBring **tools** and *ideas*.\n\n- A project\n- [Details](https://thelab.ms)\n\n<script>alert(1)</script>';
		const { path } = await create({ description });
		const html = await (await call(path)).text();
		expect(html).toContain('<div class="event-description"><h2>Make night</h2>');
		expect(html).toContain('<strong>tools</strong>');
		expect(html).toContain('<em>ideas</em>');
		expect(html).toContain('<ul><li>A project</li><li><a href="https://thelab.ms">Details</a></li></ul>');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>alert(1)</script>');
		const editHTML = await (await call(`${path}/edit`, { headers: { Cookie: cookie } })).text();
		expect(editHTML).toContain('# Make night\n\nBring **tools** and *ideas*.');
		expect(editHTML).toContain('aria-describedby="event-description-help"');
		expect(editHTML).toContain('Markdown supported:');
		expect(await (await call('/events/new', { headers: { Cookie: cookie } })).text()).toContain(
			'Markdown supported:',
		);
	});

	it('uses event length for creation and editing and retains it when the start changes', async () => {
		const newHTML = await (await call('/events/new', { headers: { Cookie: cookie } })).text();
		expect(newHTML).toContain('Event length (minutes)');
		expect(newHTML).toContain('name="minutes" min="1" max="10080" step="1" value="60" required');
		expect(newHTML).not.toContain('name="end"');
		const { id, path } = await create({ minutes: '90', repeat: 'none' });
		const editHTML = await (await call(`${path}/edit`, { headers: { Cookie: cookie } })).text();
		expect(editHTML).toContain('name="minutes" min="1" max="10080" step="1" value="90" required');
		expect(editHTML).not.toContain('name="end"');
		expect((await edit(id, 0, { start: '2027-03-08T20:00', minutes: '90' })).status).toBe(303);
		expect(await (await call(path)).text()).toContain('March 8, 2027 at 8:00 PM</strong> – 9:30 PM');
	});

	it('omits the location editor while retaining default and existing locations', async () => {
		const newHTML = await (await call('/events/new', { headers: { Cookie: cookie } })).text();
		expect(newHTML).not.toContain('event-location');
		expect(newHTML).toContain(
			'type="hidden" name="location" value="TheLab · 681 N Plano Rd, Suite 119, Richardson, TX"',
		);
		const { id, path } = await create({ location: 'Existing location' });
		const editHTML = await (await call(`${path}/edit`, { headers: { Cookie: cookie } })).text();
		expect(editHTML).not.toContain('event-location');
		expect(editHTML).toContain('type="hidden" name="location" value="Existing location"');
		expect((await edit(id, 0, { location: 'Existing location' })).status).toBe(303);
		const override = await env.DB.prepare(
			'SELECT schedule FROM calendar_overrides WHERE event_id = ? AND occurrence = 0',
		)
			.bind(id)
			.first<{ schedule: string }>();
		expect(JSON.parse(override!.schedule).location).toBe('Existing location');
		const invalid = await edit(id, 0, { location: 'Existing location', minutes: '0' });
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).toContain('type="hidden" name="location" value="Existing location"');
	});

	it('retains form input on validation errors and rejects cross-origin submissions', async () => {
		const response = await call('/events/new', post({ ...fields, capacity: '-1' }, { Cookie: cookie }));
		expect(response.status).toBe(400);
		const html = await response.text();
		expect(html).toContain(fields.description);
		expect(html).toContain(`value="${fields.start}"`);
		expect(html).toContain('name="minutes" min="1" max="10080" step="1" value="120" required');
		expect(
			(await call('/events/new', post(fields, { Cookie: cookie, Origin: 'https://elsewhere.example' }))).status,
		).toBe(403);
	});

	it('allows signed-in guests on unlimited events, keeps RSVPs private, and supports cancellation', async () => {
		const { path, id } = await create();
		expect((await call(`${path}/rsvp`, post({}))).headers.get('Location')).toContain('/login?next=');
		expect((await call(`${path}/rsvp`, post({}, { Cookie: guestCookie }))).status).toBe(303);
		expect((await call(`${path}/rsvp`, post({}, { Cookie: guestCookie }))).status).toBe(303);
		expect(await total(id)).toBe(1);
		expect(await (await call(path)).text()).not.toContain('private-attendee');
		expect(await (await call(path, { headers: { Cookie: cookie } })).text()).toContain('private-attendee');
		expect(JSON.stringify(await feed())).not.toContain('private-attendee');
		expect((await call(`${path}/leave`, post({}, { Cookie: guestCookie }))).status).toBe(303);
		expect(await total(id)).toBe(0);
	});

	it('limits capped RSVPs to active members and never overbooks concurrent requests', async () => {
		const { path, id } = await create({ capacity: '1' });
		expect((await call(`${path}/rsvp`, post({}, { Cookie: guestCookie }))).status).toBe(409);
		await env.DB.prepare('UPDATE members SET non_billable = 1 WHERE member_id = ?').bind(guest.member_id).run();
		const results = await Promise.all(
			[cookie, guestCookie].map(Cookie => call(`${path}/rsvp`, post({}, { Cookie }))),
		);
		expect(results.map(r => r.status).sort()).toEqual([303, 409]);
		expect(await total(id)).toBe(1);
		// Every occurrence gets its own capacity.
		expect((await call(`/events/${id}/1/rsvp`, post({}, { Cookie: cookie }))).status).toBe(303);
		expect(await total(id, 1)).toBe(1);
		const winner = (await env.DB.prepare(
			'SELECT member_id FROM calendar_rsvps WHERE event_id = ? AND occurrence = 0',
		)
			.bind(id)
			.first<{ member_id: string }>())!.member_id;
		const winnerCookie = winner === organizer.member_id ? cookie : guestCookie;
		expect((await call(`${path}/leave`, post({}, { Cookie: winnerCookie }))).status).toBe(303);
		expect((await call(`${path}/rsvp`, post({}, { Cookie: cookie }))).status).toBe(303);
	});

	it('checks current membership on each RSVP and retains cancellations after membership lapses', async () => {
		const { path, id } = await create({ capacity: '2' });
		await call(`${path}/rsvp`, post({}, { Cookie: cookie }));
		await env.DB.prepare('UPDATE members SET non_billable = 0 WHERE member_id = ?').bind(organizer.member_id).run();
		expect((await call(`/events/${id}/1/rsvp`, post({}, { Cookie: cookie }))).status).toBe(409);
		expect((await call(`${path}/leave`, post({}, { Cookie: cookie }))).status).toBe(303);
		expect(await total(id)).toBe(0);
	});

	it('enforces organizer ownership with an administrator override', async () => {
		const { id } = await create();
		expect((await edit(id, 0, {}, 'one', guestCookie)).status).toBe(403);
		expect((await edit(id, 0, {}, 'one', await session(guestID, true))).status).toBe(303);
	});

	it('shows managers a separate card below the same event card other members see', async () => {
		const { path } = await create();
		const ownerHTML = await (await call(path, { headers: { Cookie: cookie } })).text();
		const guestHTML = await (await call(path, { headers: { Cookie: guestCookie } })).text();
		const publicHTML = await (await call(path)).text();
		const mainCard = (html: string) =>
			html.match(/<section class="card membership-message">[\s\S]*?<\/section>/)?.[0];
		expect(mainCard(ownerHTML)).toBeDefined();
		expect(mainCard(ownerHTML)).toBe(mainCard(guestHTML));
		expect(mainCard(ownerHTML)).not.toContain('Manage event');
		expect(ownerHTML).toContain('</div></section><section class="card membership-message event-management"');
		expect(ownerHTML).toContain('Only event managers can see this card.');
		expect(guestHTML).not.toContain('Manage event');
		expect(publicHTML).not.toContain('Manage event');
	});

	it('lets leadership view attendees and manage every event without membership eligibility', async () => {
		const { id, path } = await create();
		await call(`${path}/rsvp`, post({}, { Cookie: guestCookie }));
		// Leadership need not have a member record to manage someone else's event.
		const leadershipCookie = await session(otherID, true);
		const html = await (await call(path, { headers: { Cookie: leadershipCookie } })).text();
		expect(html).toContain('class="card membership-message event-management"');
		expect(html).toContain('private-attendee');
		expect((await call(`${path}/edit`, { headers: { Cookie: leadershipCookie } })).status).toBe(200);
		expect((await edit(id, 0, {}, 'one', leadershipCookie)).status).toBe(303);
		const event = await env.DB.prepare('SELECT revision FROM calendar_events WHERE event_id = ?')
			.bind(id)
			.first<{ revision: string }>();
		expect(
			(await call(`${path}/cancel`, post({ revision: event!.revision }, { Cookie: leadershipCookie }))).status,
		).toBe(303);
		expect(await total(id)).toBe(0);
		expect((await call(path)).status).toBe(404);
	});

	it('shows cancellation controls only on the edit page, including after validation errors', async () => {
		const { id, path } = await create();
		const detailHTML = await (await call(path, { headers: { Cookie: cookie } })).text();
		expect(detailHTML).toContain(`href="${path}/edit"`);
		expect(detailHTML).not.toContain(`action="${path}/cancel"`);
		for (const Cookie of [cookie, await session(otherID, true)]) {
			const html = await (await call(`${path}/edit`, { headers: { Cookie } })).text();
			expect(html).toContain(`action="${path}/cancel"`);
			expect(html).not.toContain('id="cancel-scope"');
			expect(html).toContain('This cannot be undone.');
			expect(html).toContain('type="submit">Permanently delete event</button>');
			expect(html).toContain('</form></section><section class="card membership-message event-management"');
		}
		const invalid = await edit(id, 0, { minutes: '0' });
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).toContain(`action="${path}/cancel"`);
		const newHTML = await (await call('/events/new', { headers: { Cookie: cookie } })).text();
		expect(newHTML).not.toContain('id="cancel-scope"');
		expect((await call(`${path}/edit`, { headers: { Cookie: guestCookie } })).status).toBe(403);
	});

	it('moves one occurrence across months while preserving its URL and RSVP', async () => {
		const { id, path } = await create({ count: '3' });
		await call(`${path}/rsvp`, post({}, { Cookie: guestCookie }));
		expect((await edit(id, 0, { start: '2027-04-01T19:00' })).status).toBe(303);
		expect((await feed()).events.map(e => e.url)).not.toContain(path);
		expect((await feed('2027-04')).events.map(e => e.url)).toContain(path);
		expect(await total(id)).toBe(1);
		expect(await (await call(path, { headers: { Cookie: guestCookie } })).text()).toContain(
			`action="${path}/leave"`,
		);
	});

	it('changes this-and-future schedules without moving earlier occurrences or losing RSVPs', async () => {
		const { id, path } = await create();
		await call(`/events/${id}/2/rsvp`, post({}, { Cookie: guestCookie }));
		expect((await edit(id, 1, { start: '2027-03-16T20:00', count: '3' }, 'future')).status).toBe(303);
		const events = (await feed()).events;
		expect(events.map(e => e.date)).toEqual(['2027-03-07', '2027-03-16', '2027-03-23', '2027-03-30']);
		expect(events[0]?.url).toBe(path);
		expect(events[2]?.url).toBe(`/events/${id}/2`);
		expect(await total(id, 2)).toBe(1);
		expect((await feed('2027-04')).events).toHaveLength(0);
	});

	it('rejects edits that erase booked occurrences or shrink below the current attendee count', async () => {
		const { id } = await create();
		for (const Cookie of [cookie, guestCookie]) await call(`/events/${id}/2/rsvp`, post({}, { Cookie }));
		expect((await edit(id, 1, { count: '1' }, 'future')).status).toBe(409);
		expect((await edit(id, 1, { capacity: '1' }, 'future')).status).toBe(409);
		expect(await total(id, 2)).toBe(2);
		expect((await feed()).events.map(e => e.date)).toEqual([
			'2027-03-07',
			'2027-03-14',
			'2027-03-21',
			'2027-03-28',
		]);
	});

	it('rejects stale editor submissions and replaces future exceptions explicitly', async () => {
		const { id } = await create();
		const old = (await env.DB.prepare('SELECT revision FROM calendar_events WHERE event_id = ?')
			.bind(id)
			.first<{ revision: string }>())!.revision;
		await edit(id, 2, { title: 'One-off change' });
		expect((await edit(id, 0, { revision: old })).status).toBe(409);
		expect((await edit(id, 1, { title: 'New series', start: '2027-03-14T20:00' }, 'future')).status).toBe(303);
		expect((await feed()).events.filter(e => e.title === 'One-off change')).toHaveLength(0);
	});

	it('permanently deletes the entire event and all related rows, leaving other events intact', async () => {
		const { id, path } = await create();
		const other = await create({ title: 'Keep this event' });
		await call(`${path}/rsvp`, post({}, { Cookie: guestCookie }));
		await call(`/events/${id}/2/rsvp`, post({}, { Cookie: cookie }));
		await edit(id, 1, { start: '2027-04-01T19:00' });
		await edit(id, 2, { start: '2027-03-21T19:00' }, 'future');
		// Prime multiple calendar months before deletion.
		expect((await feed()).events.some(e => e.url === path)).toBe(true);
		expect((await feed('2027-04')).events.some(e => e.url === `/events/${id}/1`)).toBe(true);
		const response = await cancel(id, 2);
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('/#events');
		for (const table of ['calendar_events', 'calendar_schedules', 'calendar_overrides', 'calendar_rsvps']) {
			const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE event_id = ?`)
				.bind(id)
				.first<{ n: number }>();
			expect(row!.n).toBe(0);
		}
		for (const suffix of ['', '/edit', '/rsvp', '/leave', '/cancel']) {
			expect(
				(await call(`${path}${suffix}`, suffix && suffix !== '/edit' ? post({}, { Cookie: cookie }) : {}))
					.status,
			).toBe(404);
		}
		expect((await call(`/events/${id}/3`)).status).toBe(404);
		for (const month of ['2027-03', '2027-04']) {
			expect((await feed(month)).events.every(e => !e.url.includes(id))).toBe(true);
		}
		expect((await call(other.path)).status).toBe(200);
	});

	it('rejects unauthorized, stale, and cross-origin deletion requests', async () => {
		const { id, path } = await create();
		const event = await env.DB.prepare('SELECT revision FROM calendar_events WHERE event_id = ?')
			.bind(id)
			.first<{ revision: string }>();
		expect(
			(await call(`${path}/cancel`, post({ revision: event!.revision }, { Cookie: guestCookie }))).status,
		).toBe(403);
		expect(
			(
				await call(
					`${path}/cancel`,
					post({ revision: event!.revision }, { Cookie: cookie, Origin: 'https://elsewhere.example' }),
				)
			).status,
		).toBe(403);
		await edit(id, 0);
		expect((await call(`${path}/cancel`, post({ revision: event!.revision }, { Cookie: cookie }))).status).toBe(
			409,
		);
		expect((await call(path)).status).toBe(200);
	});

	it('publishes one calendar feed without a personal-events view', async () => {
		const own = await create();
		await env.DB.prepare('UPDATE members SET non_billable = 1 WHERE member_id = ?').bind(guest.member_id).run();
		const otherResponse = await call(
			'/events/new',
			post({ ...fields, title: 'Another organizer’s event' }, { Cookie: guestCookie }),
		);
		expect(otherResponse.status).toBe(303);
		const otherPath = otherResponse.headers.get('Location')!;
		const urls = (await feed()).events.map(e => e.url);
		expect(urls).toContain(own.path);
		expect(urls).toContain(otherPath);
		for (const headers of [{}, { Cookie: cookie }, { Cookie: await session(otherID, true) }]) {
			expect((await call('/events/mine', { headers })).status).toBe(404);
		}
	});

	it('does not RSVP when disabled or mutate past occurrences', async () => {
		const { path, id } = await create({ rsvp: '' });
		expect((await call(`${path}/rsvp`, post({}, { Cookie: guestCookie }))).status).toBe(409);
		vi.setSystemTime(new Date('2027-03-09T00:00:00Z'));
		cookie = await session(organizerID);
		expect((await edit(id, 0)).status).toBe(400);
		expect((await cancel(id, 0)).status).toBe(400);
	});

	it('preserves past history when an earlier occurrence was moved beyond later occurrences', async () => {
		const { id } = await create();
		expect((await edit(id, 0, { start: '2027-04-01T19:00' })).status).toBe(303);
		vi.setSystemTime(new Date('2027-03-15T12:00:00Z'));
		cookie = await session(organizerID);
		expect((await edit(id, 0, { start: '2027-04-02T19:00' }, 'future')).status).toBe(400);
		expect((await edit(id, 0, { start: '2027-04-02T19:00' })).status).toBe(303);
	});

	it('retains a series repeat configuration when editing a previously overridden occurrence', async () => {
		const { id } = await create({ count: '4' });
		await edit(id, 1, { start: '2027-03-15T19:00' });
		const html = await (await call(`/events/${id}/1/edit`, { headers: { Cookie: cookie } })).text();
		expect(html).toContain('value="weekly" selected');
		expect(html).toContain('type="hidden" name="count" value="3"');
	});

	it('omits repeat-limit inputs while preserving existing limits when editing', async () => {
		const newHTML = await (await call('/events/new', { headers: { Cookie: cookie } })).text();
		expect(newHTML).not.toContain('Last repeat date');
		expect(newHTML).not.toContain('Or number of occurrences');
		expect(newHTML).not.toContain('name="until"');
		expect(newHTML).not.toContain('name="count"');
		for (const limit of [{ until: '2027-03-21' }, { count: '3' }]) {
			const { id, path } = await create(limit);
			const html = await (await call(`${path}/edit`, { headers: { Cookie: cookie } })).text();
			expect(html).not.toContain('Last repeat date');
			expect(html).not.toContain('Or number of occurrences');
			const [name, value] = Object.entries(limit)[0]!;
			expect(html).toContain(`type="hidden" name="${name}" value="${value}"`);
			expect((await edit(id, 0, { start: fields.start, ...limit }, 'future')).status).toBe(303);
			expect((await call(`/events/${id}/3`)).status).toBe(404);
		}
	});

	it('offers only no repeat, weekly weekday, and monthly weekday-position recurrence', async () => {
		const { id, path } = await create({ start: '2027-01-09T19:00', repeat: 'ordinal' });
		const html = await (await call(`${path}/edit`, { headers: { Cookie: cookie } })).text();
		const choices = html.match(/<select id="event-repeat"[\s\S]*?<\/select>/)![0];
		expect(choices.match(/<option /g)).toHaveLength(3);
		expect(choices).toContain('Does not repeat');
		expect(choices).toContain('Every Saturday');
		expect(choices).toContain('The second Saturday of every month');
		expect(choices).not.toContain('value="daily"');
		expect(choices).not.toContain('value="monthly"');
		expect(html).not.toContain('event-ordinal');
		expect(html).not.toContain('event-interval');
		expect(html).toContain('src="/event-form.js" defer');
		expect((await feed('2027-02')).events.map(e => e.date)).toEqual(['2027-02-13']);
		expect(
			(
				await edit(
					id,
					0,
					{
						start: '2027-02-20T19:00',
						repeat: 'ordinal',
						ordinal: '2',
						recurrence_start: '2027-01-09T19:00',
					},
					'future',
				)
			).status,
		).toBe(303);
		expect((await feed('2027-03')).events.map(e => e.date)).toEqual(['2027-03-20']);
		expect(await (await call(path)).text()).toContain('The third Saturday of every month');
		for (const extra of [{ repeat: 'daily' }, { repeat: 'monthly' }, { interval: '2' }]) {
			expect((await call('/events/new', post({ ...fields, ...extra }, { Cookie: cookie }))).status).toBe(400);
		}
	});

	it('keeps capacity safe when a capacity edit races a new RSVP', async () => {
		const { id, path } = await create();
		await call(`${path}/rsvp`, post({}, { Cookie: guestCookie }));
		await insertMember({ discord_user_id: otherID, non_billable: 1 });
		const otherCookie = await session(otherID);
		await Promise.all([edit(id, 0, { capacity: '1' }), call(`${path}/rsvp`, post({}, { Cookie: otherCookie }))]);
		const count = await total(id);
		const summary = (await feed()).events.find(e => e.url === path)!.summary;
		expect(count === 1 || summary.includes('Open RSVP')).toBe(true);
	});
});
