import { Temporal } from '@js-temporal/polyfill';
import { h, Fragment } from './html.ts';
import { page } from './page.tsx';
import { markdown } from './markdown.ts';
import {
	HttpError,
	loginRedirect,
	memberAccessSQL,
	memberName,
	memberQuery,
	randomToken,
	readForm,
	readSession,
	redirect,
	type CalendarEvent,
	type CalendarOverride,
	type CalendarSchedule,
	type Form,
	type Member,
	type Session,
} from './lib.ts';
import {
	EVENT_ZONE,
	instant,
	localInput,
	localNow,
	occurrenceAt,
	occurrenceCount,
	occurrencesBetween,
	readSchedule,
	repeatLabel,
	repeats,
	startSeconds,
	type Schedule,
} from './recurrence.ts';

interface Count {
	event_id: string;
	occurrence: number;
	total: number;
}
interface Bundle {
	events: CalendarEvent[];
	schedules: CalendarSchedule[];
	overrides: CalendarOverride[];
	counts: Count[];
}
interface Occurrence {
	event: CalendarEvent;
	number: number;
	schedule: Schedule;
	total: number;
}
type Viewer = { session: Session | null; member: (Member & { eligible: number }) | null };
const eventPath = (id: string, n: number) => `/events/${id}/${n}`;
const decode = (row: { schedule: string }) => JSON.parse(row.schedule) as Schedule;
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: EVENT_ZONE, dateStyle: 'long', timeStyle: 'short' });
const time = (seconds: number) => timeFormat.format(new Date(seconds * 1000));
const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: EVENT_ZONE, dateStyle: 'long' });
const clockFormat = new Intl.DateTimeFormat('en-US', { timeZone: EVENT_ZONE, timeStyle: 'short' });
const rangeEnd = (start: number, end: number) =>
	dateFormat.format(new Date(start * 1000)) === dateFormat.format(new Date(end * 1000))
		? clockFormat.format(new Date(end * 1000))
		: time(end);

async function viewer(request: Request, env: Env): Promise<Viewer> {
	const session = await readSession(request, env);
	return {
		session,
		member: session
			? await memberQuery(env, session, `members.*, ${memberAccessSQL} AS eligible`).first<
					Member & { eligible: number }
				>()
			: null,
	};
}

async function load(env: Env, id?: string): Promise<Bundle> {
	const where = id ? ' WHERE event_id = ?' : '';
	const query = (sql: string) => (id ? env.DB.prepare(sql).bind(id) : env.DB.prepare(sql));
	const results = await env.DB.batch([
		query(`SELECT * FROM calendar_events${where}`),
		query(`SELECT * FROM calendar_schedules${where} ORDER BY first_occurrence`),
		query(`SELECT * FROM calendar_overrides${where}`),
		query(
			`SELECT event_id, occurrence, COUNT(*) AS total FROM calendar_rsvps${where} GROUP BY event_id, occurrence`,
		),
	]);
	if (!results[0] || !results[1] || !results[2] || !results[3]) throw new Error('Incomplete calendar query results.');
	return {
		events: results[0].results as unknown as CalendarEvent[],
		schedules: results[1].results as unknown as CalendarSchedule[],
		overrides: results[2].results as unknown as CalendarOverride[],
		counts: results[3].results as unknown as Count[],
	};
}

function resolve(bundle: Bundle, event: CalendarEvent, number: number): Occurrence {
	const version = bundle.schedules.findLast(s => s.event_id === event.event_id && s.first_occurrence <= number);
	const base = version && occurrenceAt(decode(version), number - version.first_occurrence);
	if (!base) throw new HttpError(404, 'Event occurrence not found.');
	const override = bundle.overrides.find(o => o.event_id === event.event_id && o.occurrence === number);
	const schedule = override ? decode(override) : base;
	if (event.cancel_from !== null && number >= event.cancel_from) schedule.cancelled = true;
	return {
		event,
		number,
		schedule,
		total: bundle.counts.find(c => c.event_id === event.event_id && c.occurrence === number)?.total ?? 0,
	};
}

function monthWindow(value: string | null) {
	let month: Temporal.PlainDate;
	try {
		const text = value ?? localNow().toString().slice(0, 7);
		if (!/^\d{4}-\d\d$/.test(text)) throw new Error();
		month = Temporal.PlainDate.from(`${text}-01`);
		const current = localNow().toPlainDate().with({ day: 1 });
		if (
			Temporal.PlainDate.compare(month, current.subtract({ months: 12 })) < 0 ||
			Temporal.PlainDate.compare(month, current.add({ months: 24 })) > 0
		)
			throw new Error();
	} catch {
		throw new HttpError(400, 'Choose a month within the past year or next two years.');
	}
	const next = month.add({ months: 1 });
	return {
		month,
		from: instant(`${month}T00:00`).epochMilliseconds / 1000,
		to: instant(`${next}T00:00`).epochMilliseconds / 1000,
	};
}

function inWindow(bundle: Bundle, from: number, to: number) {
	const result: Occurrence[] = [];
	for (const event of bundle.events) {
		const versions = bundle.schedules.filter(s => s.event_id === event.event_id);
		const overridden = new Set(bundle.overrides.filter(o => o.event_id === event.event_id).map(o => o.occurrence));
		for (const [i, version] of versions.entries()) {
			const max = (versions[i + 1]?.first_occurrence ?? Infinity) - version.first_occurrence;
			for (const item of occurrencesBetween(decode(version), from, to, max)) {
				const number = version.first_occurrence + item.offset;
				if (!overridden.has(number)) {
					if (event.cancel_from !== null && number >= event.cancel_from) item.schedule.cancelled = true;
					result.push({
						event,
						number,
						schedule: item.schedule,
						total:
							bundle.counts.find(c => c.event_id === event.event_id && c.occurrence === number)?.total ??
							0,
					});
				}
			}
		}
		// Moved occurrences must appear in their new month, even if the original date
		// is outside the window. Suppress the original date using the set above.
		for (const override of bundle.overrides.filter(o => o.event_id === event.event_id)) {
			const schedule = decode(override),
				start = startSeconds(schedule);
			if (start < to && start + schedule.minutes * 60 > from)
				result.push(resolve(bundle, event, override.occurrence));
		}
	}
	return result.sort(
		(a, b) =>
			startSeconds(a.schedule) - startSeconds(b.schedule) || a.event.event_id.localeCompare(b.event.event_id),
	);
}

function summary(item: Occurrence) {
	const { schedule, total } = item;
	return schedule.cancelled
		? 'Cancelled'
		: !schedule.rsvp
			? ''
			: schedule.capacity === null
				? `${total} going · Open RSVP`
				: `${Math.max(0, schedule.capacity - total)} of ${schedule.capacity} spots left`;
}

async function calendarFeed(request: Request, env: Env, ctx: ExecutionContext) {
	const { month, from, to } = monthWindow(new URL(request.url).searchParams.get('month'));
	const monthKey = month.toString().slice(0, 7);
	// This feed is identical for every visitor; key only by canonical month and
	// keep it briefly fresh so calendar edits and RSVP counts propagate quickly.
	const cacheKey = new Request(new URL(`/events/data?month=${monthKey}`, request.url));
	const cache = caches.default;
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	const occurrences = inWindow(await load(env), from, to);
	const response = Response.json(
		{
			month: monthKey,
			timezone: EVENT_ZONE,
			events: occurrences.map(item => ({
				url: eventPath(item.event.event_id, item.number),
				title: item.schedule.title,
				start: new Date(startSeconds(item.schedule) * 1000).toISOString(),
				end: new Date((startSeconds(item.schedule) + item.schedule.minutes * 60) * 1000).toISOString(),
				date: instant(item.schedule.start).toPlainDate().toString(),
				summary: summary(item),
				cancelled: item.schedule.cancelled,
			})),
		},
		{ headers: { 'Cache-Control': 'public, max-age=60' } },
	);
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

function cancelCard(path: string, revision: string) {
	return (
		<section class="card membership-message event-management" aria-labelledby="event-cancel-title">
			<h2 id="event-cancel-title">Cancel event</h2>
			<p class="card-desc">
				Permanently delete this entire event, including all recurring occurrences and RSVPs. This cannot be
				undone.
			</p>
			<form method="post" action={`${path}/cancel`} class="event-form">
				<input type="hidden" name="revision" value={revision} />
				<button class="btn btn-outline" type="submit">
					Permanently delete event
				</button>
			</form>
		</section>
	);
}

function eventForm(schedule: Schedule, action: string, revision?: string, scope = 'one') {
	return (
		<form method="post" action={action} class="event-form">
			{revision && (
				<>
					<input type="hidden" name="revision" value={revision} />
					<label for="event-scope">Apply changes to</label>
					<select id="event-scope" name="scope">
						<option value="one" selected={scope === 'one'}>
							Only this occurrence
						</option>
						<option value="future" selected={scope === 'future'}>
							This and future occurrences
						</option>
					</select>
				</>
			)}
			<label for="event-title">Title</label>
			<input id="event-title" name="title" value={schedule.title} required maxlength="120" />
			<label for="event-description">Description</label>
			<textarea
				id="event-description"
				name="description"
				rows="5"
				maxlength="5000"
				aria-describedby="event-description-help"
			>
				{schedule.description}
			</textarea>
			<p id="event-description-help" class="card-desc">
				Markdown supported: # headings, **bold**, *italic*, - lists, [links](https://example.com), &gt; quotes,
				and `code`. Separate paragraphs with a blank line.
			</p>
			<input type="hidden" name="location" value={schedule.location} />
			<label for="event-start">Start (Central time)</label>
			<input id="event-start" type="datetime-local" name="start" value={schedule.start} required />
			<label for="event-minutes">Event length (minutes)</label>
			<input
				id="event-minutes"
				type="number"
				name="minutes"
				min="1"
				max="10080"
				step="1"
				value={schedule.minutes}
				required
			/>
			<label for="event-repeat">Repeat</label>
			<select id="event-repeat" name="repeat" required aria-describedby="event-repeat-help">
				{!Object.hasOwn(repeats, schedule.repeat) && (
					<option value="" selected disabled>
						Choose a new repeat pattern
					</option>
				)}
				{Object.entries(repeats).map(([value, label]) => (
					<option value={value} selected={schedule.repeat === value}>
						{value === 'none'
							? label
							: repeatLabel({
									...schedule,
									repeat: value as keyof typeof repeats,
									interval: 1,
									until: '',
									count: null,
								})}
					</option>
				))}
			</select>
			{schedule.ordinal !== undefined && (
				<>
					<input type="hidden" name="ordinal" value={schedule.ordinal} />
					<input type="hidden" name="recurrence_start" value={schedule.start} />
				</>
			)}
			{/* Preserve existing series limits without exposing them as editable fields. */}
			{schedule.until && <input type="hidden" name="until" value={schedule.until} />}
			{schedule.count !== null && <input type="hidden" name="count" value={schedule.count} />}
			<label for="event-rsvp">
				<input id="event-rsvp" type="checkbox" name="rsvp" value="1" checked={schedule.rsvp} /> Accept RSVPs
			</label>
			<label for="event-capacity">RSVP limit per occurrence (blank means unlimited)</label>
			<input id="event-capacity" type="number" name="capacity" min="1" max="10000" value={schedule.capacity} />
			<p class="card-desc">
				A limit restricts new RSVPs to active members. Without a limit, anyone signed in through Discord can
				RSVP. Existing RSVPs are retained if eligibility changes.
			</p>
			<button class="btn btn-primary" type="submit">
				{revision ? 'Save changes' : 'Publish event'}
			</button>
			<script src="/event-form.js" defer />
		</form>
	);
}

async function create(request: Request, env: Env) {
	const { session, member } = await viewer(request, env);
	if (!session) return loginRedirect('/events/new');
	if (!member?.eligible) throw new HttpError(403, 'An active membership is required to create events.');
	if (request.method === 'GET') {
		const schedule: Schedule = {
			title: '',
			description: '',
			location: 'TheLab · 681 N Plano Rd, Suite 119, Richardson, TX',
			start: localInput(localNow().add({ days: 1 }).with({ hour: 19, minute: 0 })),
			minutes: 60,
			repeat: 'none',
			interval: 1,
			until: '',
			count: null,
			rsvp: true,
			capacity: null,
			cancelled: false,
		};
		return page('Create an event', eventForm(schedule, '/events/new'), { wide: true });
	}
	const form = await readForm(request);
	let schedule: Schedule;
	try {
		schedule = readSchedule(form);
	} catch (error) {
		return formError(error, form, '/events/new');
	}
	const id = randomToken().slice(0, 32);
	const created = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO calendar_events (event_id, organizer_id, revision) SELECT ?, member_id, ? FROM members WHERE member_id = ? AND ${memberAccessSQL}`,
		).bind(id, randomToken(), member.member_id),
		env.DB.prepare(
			'INSERT INTO calendar_schedules (event_id, first_occurrence, schedule) SELECT event_id, 0, ? FROM calendar_events WHERE event_id = ? RETURNING event_id',
		).bind(JSON.stringify(schedule), id),
	]);
	if (!created[1]?.results.length) throw new HttpError(403, 'An active membership is required to create events.');
	return redirect(eventPath(id, 0));
}

// Retain submitted values after validation errors rather than discarding a long
// description. Dates fall back only when they cannot be parsed for display.
function formError(error: unknown, form: Form, action: string, revision?: string) {
	if (!(error instanceof HttpError)) throw error;
	let start = localInput(localNow().add({ days: 1 })),
		minutes = 60;
	try {
		start = localInput(Temporal.PlainDateTime.from(form.start ?? ''));
	} catch {
		/* Use default. */
	}
	if (form.minutes && Number.isFinite(Number(form.minutes))) minutes = Number(form.minutes);
	const schedule: Schedule = {
		title: form.title || '',
		description: form.description || '',
		location: form.location || '',
		start,
		minutes,
		repeat: Object.hasOwn(repeats, form.repeat || '') ? (form.repeat as Schedule['repeat']) : 'none',
		interval: 1,
		...(form.ordinal &&
		[-1, 1, 2, 3, 4].includes(Number(form.ordinal)) &&
		(!form.recurrence_start || form.recurrence_start.slice(0, 10) === form.start?.slice(0, 10))
			? { ordinal: Number(form.ordinal) }
			: {}),
		until: form.until || '',
		count: Number(form.count) || null,
		rsvp: form.rsvp === '1',
		capacity: Number(form.capacity) || null,
		cancelled: false,
	};
	return page(
		'Check your event',
		<>
			<p role="alert">{error.message}</p>
			{eventForm(schedule, action, revision, form.scope)}
		</>,
		{
			status: error.status,
			wide: true,
			afterCard: revision ? cancelCard(action.replace(/\/edit$/, ''), revision) : undefined,
		},
	);
}

// Leadership's Discord admin role grants management of every event, even without
// an active membership or an organizer relationship.
const canManage = (view: Viewer, event: CalendarEvent) =>
	!!view.session && (view.session.admin || (!!view.member && view.member.member_id === event.organizer_id));

async function detail(env: Env, item: Occurrence, view: Viewer) {
	const { event, number, schedule, total } = item;
	const path = eventPath(event.event_id, number),
		start = startSeconds(schedule);
	const own = view.member
		? await env.DB.prepare('SELECT 1 FROM calendar_rsvps WHERE event_id = ? AND occurrence = ? AND member_id = ?')
				.bind(event.event_id, number, view.member.member_id)
				.first()
		: null;
	const manager = canManage(view, event);
	const attendees = manager
		? (
				await env.DB.prepare(`SELECT members.* FROM calendar_rsvps JOIN members USING (member_id)
    WHERE event_id = ? AND occurrence = ? ORDER BY calendar_rsvps.created, member_id`)
					.bind(event.event_id, number)
					.all<Member>()
			).results
		: [];
	const eligible = schedule.capacity === null || !!view.member?.eligible;
	const open = !schedule.cancelled && schedule.rsvp && start > Date.now() / 1000;
	return page(
		schedule.title,
		<div class="events-page">
			<p>
				<strong>{time(start)}</strong> – {rangeEnd(start, start + schedule.minutes * 60)}
			</p>
			<div class="event-description">{markdown(schedule.description)}</div>
			<p>{repeatLabel(schedule)}</p>
			<p class="event-rsvp-summary" role="status">
				{summary(item)}
			</p>
			{own ? (
				<>
					<p>{schedule.cancelled ? 'Your RSVP is retained for this cancelled event.' : ''}</p>
					<form method="post" action={`${path}/leave`}>
						<button class="btn btn-outline" type="submit">
							Cancel my RSVP
						</button>
					</form>
				</>
			) : (
				open &&
				(!view.session ? (
					<a class="btn btn-primary" href={`/login?next=${encodeURIComponent(path)}`}>
						Sign in with Discord to RSVP
					</a>
				) : !eligible ? (
					<p>An active membership is required to RSVP to this event.</p>
				) : (
					<form method="post" action={`${path}/rsvp`}>
						<button
							class="btn btn-primary"
							type="submit"
							disabled={schedule.capacity !== null && total >= schedule.capacity}
						>
							RSVP
						</button>
					</form>
				))
			)}
			{!schedule.cancelled && start <= Date.now() / 1000 && (
				<p>RSVPs are closed because this event has started.</p>
			)}
		</div>,
		{
			wide: true,
			afterCard: manager && (
				<section class="card membership-message event-management" aria-labelledby="event-management-title">
					<h2 id="event-management-title">Manage event</h2>
					<p class="card-desc">Only event managers can see this card.</p>
					{start > Date.now() / 1000 && (
						<p>
							<a href={`${path}/edit`}>Edit event</a>
						</p>
					)}
					<h3>Attendees ({total})</h3>
					{attendees.length ? (
						attendees.map(member => (
							<p>
								{memberName(member)}
								{member.discord_username ? ` (@${member.discord_username})` : ''}
							</p>
						))
					) : (
						<p>No RSVPs yet.</p>
					)}
				</section>
			),
		},
	);
}

async function rsvp(env: Env, item: Occurrence, view: Viewer, leave: boolean) {
	const { event, number, schedule } = item,
		path = eventPath(event.event_id, number);
	if (!view.session) return loginRedirect(path);
	if (!view.member) throw new HttpError(403, 'Your Discord account must be registered with TheLab.');
	if (leave) {
		await env.DB.prepare('DELETE FROM calendar_rsvps WHERE event_id = ? AND occurrence = ? AND member_id = ?')
			.bind(event.event_id, number, view.member.member_id)
			.run();
		return redirect(`${path}?notice=left`);
	}
	// This single SQLite statement serializes the count and insert. The revision
	// guard prevents a concurrent edit/cancellation from admitting an obsolete RSVP.
	const result = await env.DB.prepare(`INSERT INTO calendar_rsvps (event_id, occurrence, member_id)
    SELECT ?1, ?2, members.member_id FROM members JOIN calendar_events ON calendar_events.event_id = ?1
    WHERE members.member_id = ?3 AND calendar_events.revision = ?4
      AND ?5 > unixepoch() AND ?6 = 1 AND ?7 = 0
      AND (calendar_events.cancel_from IS NULL OR ?2 < calendar_events.cancel_from)
      AND (?8 IS NULL OR (${memberAccessSQL} AND (SELECT COUNT(*) FROM calendar_rsvps WHERE event_id = ?1 AND occurrence = ?2) < ?8))
    ON CONFLICT DO NOTHING RETURNING member_id`)
		.bind(
			event.event_id,
			number,
			view.member.member_id,
			event.revision,
			startSeconds(schedule),
			schedule.rsvp ? 1 : 0,
			schedule.cancelled ? 1 : 0,
			schedule.capacity,
		)
		.first();
	const existing =
		result ||
		(await env.DB.prepare('SELECT 1 FROM calendar_rsvps WHERE event_id = ? AND occurrence = ? AND member_id = ?')
			.bind(event.event_id, number, view.member.member_id)
			.first());
	if (!existing)
		throw new HttpError(
			409,
			'RSVP unavailable: the event may be full, changed, cancelled, or restricted to active members. Return to the event and try again.',
		);
	return redirect(`${path}?notice=rsvp`);
}

async function edit(request: Request, env: Env, bundle: Bundle, item: Occurrence, view: Viewer, cancel: boolean) {
	const { event, number } = item,
		path = eventPath(event.event_id, number);
	if (!view.session) return loginRedirect(`${path}/edit`);
	if (!canManage(view, event))
		throw new HttpError(403, 'Only the organizer or an administrator can manage this event.');
	if (startSeconds(item.schedule) <= Date.now() / 1000)
		throw new HttpError(400, 'Past or in-progress occurrences cannot be changed.');
	if (request.method === 'GET') {
		// A count is relative to the first occurrence of its schedule version.
		const version = bundle.schedules.findLast(s => s.first_occurrence <= number);
		if (!version) throw new HttpError(404, 'Event occurrence not found.');
		const schedule = { ...item.schedule };
		const base = decode(version);
		schedule.repeat = base.repeat;
		schedule.interval = base.interval;
		if (base.ordinal !== undefined) schedule.ordinal = base.ordinal;
		schedule.until = base.until;
		schedule.count = base.count ? base.count - (number - version.first_occurrence) : null;
		return page('Edit event', eventForm(schedule, `${path}/edit`, event.revision), {
			wide: true,
			afterCard: cancelCard(path, event.revision),
		});
	}
	const form = await readForm(request);
	if (form.revision !== event.revision)
		throw new HttpError(409, 'This event changed while you were editing. Reload it before saving.');
	if (cancel) {
		// Foreign-key cascades remove all schedules, exceptions, and RSVPs without
		// leaving a cancelled occurrence or tombstone behind.
		const deleted = await env.DB.prepare(
			'DELETE FROM calendar_events WHERE event_id = ? AND revision = ? RETURNING event_id',
		)
			.bind(event.event_id, event.revision)
			.first();
		if (!deleted) throw new HttpError(409, 'This event changed while you were editing. Reload it before deleting.');
		// A series can appear in any supported month; clear every local feed key.
		const month = localNow().toPlainDate().with({ day: 1 });
		await Promise.all(
			Array.from({ length: 37 }, (_, i) =>
				caches.default.delete(
					new Request(
						new URL(
							`/events/data?month=${month
								.add({ months: i - 12 })
								.toString()
								.slice(0, 7)}`,
							request.url,
						),
					),
				),
			),
		);
		return redirect('/#events');
	}
	if (form.scope !== 'one' && form.scope !== 'future')
		throw new HttpError(400, 'Choose which occurrences to change.');
	const future = form.scope === 'future',
		token = randomToken();
	if (future) {
		const earliest = Math.min(
			...bundle.schedules.map(s => startSeconds(decode(s))),
			...bundle.overrides.map(s => startSeconds(decode(s))),
		);
		if (inWindow(bundle, earliest - 1, Date.now() / 1000).some(o => o.number >= number)) {
			throw new HttpError(
				400,
				'A later occurrence has already started. Edit individual future occurrences instead.',
			);
		}
	}
	let schedule: Schedule;
	try {
		schedule = readSchedule(future ? form : { ...form, repeat: 'none', count: '', until: '', interval: '1' });
	} catch (error) {
		return formError(error, form, `${path}/edit`, event.revision);
	}
	const size = occurrenceCount(schedule),
		end = future ? null : number + 1;
	const removedFrom = future && size !== null ? number + size : null;
	// Check capacity and shortened recurrence against live RSVP rows in the same
	// transaction as the edit. New RSVPs cannot slip between validation and save.
	const statements = [
		env.DB.prepare(`UPDATE calendar_events SET revision = ?1
    WHERE event_id = ?3 AND revision = ?4
      AND (?5 IS NULL OR NOT EXISTS (SELECT 1 FROM calendar_rsvps WHERE event_id = ?3 AND occurrence >= ?5))
      AND (?6 IS NULL OR NOT EXISTS (SELECT 1 FROM calendar_rsvps WHERE event_id = ?3 AND occurrence >= ?2
        AND (?7 IS NULL OR occurrence < ?7) GROUP BY occurrence HAVING COUNT(*) > ?6))
    RETURNING revision`).bind(token, number, event.event_id, event.revision, removedFrom, schedule.capacity, end),
	];
	const guard = 'EXISTS (SELECT 1 FROM calendar_events WHERE event_id = ?1 AND revision = ?2)';
	if (future) {
		if (event.cancel_from !== null && number >= event.cancel_from)
			throw new HttpError(400, 'This series has ended. Create a new event to restart it.');
		statements.push(
			env.DB.prepare(
				`DELETE FROM calendar_schedules WHERE event_id = ?1 AND first_occurrence >= ?3 AND ${guard}`,
			).bind(event.event_id, token, number),
			env.DB.prepare(`DELETE FROM calendar_overrides WHERE event_id = ?1 AND occurrence >= ?3 AND ${guard}`).bind(
				event.event_id,
				token,
				number,
			),
			env.DB.prepare(
				`INSERT INTO calendar_schedules (event_id, first_occurrence, schedule) SELECT ?1, ?3, ?4 WHERE ${guard}`,
			).bind(event.event_id, token, number, JSON.stringify(schedule)),
		);
	} else if (!future) {
		statements.push(
			env.DB.prepare(`INSERT INTO calendar_overrides (event_id, occurrence, schedule) SELECT ?1, ?3, ?4 WHERE ${guard}
      ON CONFLICT (event_id, occurrence) DO UPDATE SET schedule = excluded.schedule`).bind(
				event.event_id,
				token,
				number,
				JSON.stringify(schedule),
			),
		);
	}
	const results = await env.DB.batch(statements);
	if (!results[0]?.results.length)
		throw new HttpError(
			409,
			'The event changed, or this edit would remove an occurrence with RSVPs or reduce capacity below its attendee count. Reload the event and adjust your changes.',
		);
	return redirect(`${path}?notice=saved`);
}

export async function eventsRequest(request: Request, env: Env, ctx: ExecutionContext) {
	const path = new URL(request.url).pathname;
	if (request.method === 'GET' && path === '/events/data') return calendarFeed(request, env, ctx);
	if (request.method === 'GET' && path === '/events') return redirect('/#events');
	if (['GET', 'POST'].includes(request.method) && path === '/events/new') return create(request, env);
	const match = path.match(/^\/events\/([a-f0-9]{32})\/(0|[1-9]\d{0,4})(?:\/(edit|cancel|rsvp|leave))?$/);
	if (!match) throw new HttpError(404, 'Page not found.');
	const [, id, raw, action] = match,
		number = Number(raw);
	const [bundle, view] = await Promise.all([load(env, id), viewer(request, env)]);
	const event = bundle.events[0];
	if (!event) throw new HttpError(404, 'Event not found.');
	const item = resolve(bundle, event, number);
	if (request.method === 'GET' && !action) return detail(env, item, view);
	if (action === 'edit' && ['GET', 'POST'].includes(request.method))
		return edit(request, env, bundle, item, view, false);
	if (request.method === 'POST') {
		if (action === 'cancel') return edit(request, env, bundle, item, view, true);
		if (action === 'rsvp' || action === 'leave') return rsvp(env, item, view, action === 'leave');
	}
	throw new HttpError(404, 'Page not found.');
}
