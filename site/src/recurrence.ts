// RRule operates on floating calendar dates; Temporal alone converts those dates
// to instants. Never feed UTC instants to the recurrence engine (DST would drift).
import { RRule } from 'rrule';
import { Temporal } from '@js-temporal/polyfill';
import { HttpError, type Form } from './lib.ts';

export const EVENT_ZONE = 'America/Chicago';
export const repeats = { none: 'Does not repeat', weekly: 'Weekly', ordinal: 'Monthly on this weekday' } as const;
export interface Schedule {
	title: string;
	description: string;
	location: string;
	start: string;
	minutes: number;
	// Legacy daily/date-based schedules remain readable, but cannot be created.
	repeat: keyof typeof repeats | 'daily' | 'monthly';
	ordinal?: number;
	interval: number;
	until: string;
	count: number | null;
	rsvp: boolean;
	capacity: number | null;
	cancelled: boolean;
}

export const localNow = () => Temporal.Now.zonedDateTimeISO(EVENT_ZONE).toPlainDateTime();
export const localInput = (value: Temporal.PlainDateTime) => value.toString({ smallestUnit: 'minute' });
export const instant = (local: string) =>
	Temporal.PlainDateTime.from(local).toZonedDateTime(EVENT_ZONE, { disambiguation: 'compatible' });
export const startSeconds = (schedule: Schedule) => Math.floor(instant(schedule.start).epochMilliseconds / 1000);
const position = (date: Temporal.PlainDateTime) => (Math.ceil(date.day / 7) === 5 ? -1 : Math.ceil(date.day / 7));

function integer(value: string | undefined, fallback: number, max: number) {
	if (!value) return fallback;
	if (!/^[1-9]\d*$/.test(value) || Number(value) > max)
		throw new HttpError(400, `Enter a whole number between 1 and ${max}.`);
	return Number(value);
}

export function readSchedule(form: Form): Schedule {
	const title = form.title?.trim() || '',
		description = form.description?.trim() || '',
		location = form.location?.trim() || '';
	if (!title || title.length > 120 || description.length > 5000 || !location || location.length > 200) {
		throw new HttpError(
			400,
			'Enter a title (up to 120 characters), location (up to 200), and description (up to 5,000).',
		);
	}
	let start: Temporal.PlainDateTime;
	try {
		if (!form.start || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(form.start)) throw new Error();
		start = Temporal.PlainDateTime.from(form.start);
	} catch {
		throw new HttpError(400, 'Enter a valid start date and time.');
	}
	const seconds = instant(localInput(start)).epochMilliseconds / 1000;
	if (seconds <= Date.now() / 1000 || Temporal.PlainDateTime.compare(start, localNow().add({ years: 2 })) > 0) {
		throw new HttpError(400, 'Choose a future start within the next two years.');
	}
	if (!form.minutes || !/^[1-9]\d*$/.test(form.minutes) || Number(form.minutes) > 7 * 24 * 60) {
		throw new HttpError(400, 'Enter an event length in whole minutes between 1 and 10080 (seven days).');
	}
	const minutes = Number(form.minutes);
	const repeat = form.repeat || 'none';
	if (!Object.hasOwn(repeats, repeat)) throw new HttpError(400, 'Choose a supported repeat pattern.');
	const interval = integer(form.interval, 1, 52);
	if (interval !== 1) throw new HttpError(400, 'Repeats must occur every week or every month.');
	let ordinal: number | undefined;
	if (repeat === 'ordinal') {
		// Keep an existing monthly position when only its time/details change;
		// changing the start date chooses the position of the new date, even with JS off.
		ordinal =
			form.ordinal &&
			(!form.recurrence_start || form.recurrence_start.slice(0, 10) === start.toPlainDate().toString())
				? Number(form.ordinal)
				: position(start);
		if (![-1, 1, 2, 3, 4].includes(ordinal)) throw new HttpError(400, 'Choose a valid monthly weekday position.');
	}
	const count = repeat === 'none' || !form.count ? null : integer(form.count, 1, 10000);
	const until = repeat === 'none' ? '' : form.until || '';
	if (until) {
		try {
			if (!/^\d{4}-\d\d-\d\d$/.test(until)) throw new Error();
			const date = Temporal.PlainDate.from(until);
			if (
				Temporal.PlainDate.compare(date, start.toPlainDate()) < 0 ||
				Temporal.PlainDate.compare(date, start.toPlainDate().add({ years: 10 })) > 0
			)
				throw new Error();
		} catch {
			throw new HttpError(400, 'The repeat end date must be on or after the start and within ten years.');
		}
	}
	if (count && until) throw new HttpError(400, 'Choose an end date or an occurrence count, rather than both.');
	return {
		title,
		description,
		location,
		start: localInput(start),
		minutes,
		repeat: repeat as Schedule['repeat'],
		...(ordinal !== undefined ? { ordinal } : {}),
		interval,
		until,
		count,
		rsvp: form.rsvp === '1',
		capacity: form.capacity ? integer(form.capacity, 1, 10000) : null,
		cancelled: false,
	};
}

const floating = (local: string) => new Date(`${local}:00Z`);

function rule(schedule: Schedule) {
	const date = Temporal.PlainDateTime.from(schedule.start);
	const weekday = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU][date.dayOfWeek - 1];
	if (!weekday) throw new Error('Invalid recurrence weekday.');
	// A fifth weekday means the last weekday of the month, a useful monthly preset.
	const nth = schedule.ordinal ?? position(date);
	return new RRule(
		{
			dtstart: floating(schedule.start),
			freq:
				schedule.repeat === 'daily' ? RRule.DAILY : schedule.repeat === 'weekly' ? RRule.WEEKLY : RRule.MONTHLY,
			interval: schedule.interval,
			...(schedule.repeat === 'ordinal' ? { byweekday: weekday.nth(nth) } : {}),
			...(schedule.repeat === 'none' ? { count: 1 } : schedule.count ? { count: schedule.count } : {}),
			...(schedule.until ? { until: new Date(`${schedule.until}T23:59:59Z`) } : {}),
		},
		true,
	);
}

export function occurrenceAt(schedule: Schedule, offset: number): Schedule | null {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return null;
	let found: Date | undefined;
	const horizon = floating(localInput(localNow().add({ years: 2, days: 32 })));
	rule(schedule).all((date, i) => {
		if (date > horizon) return false;
		if (i === offset) {
			found = date;
			return false;
		}
		return true;
	});
	return found ? { ...schedule, start: found.toISOString().slice(0, 16) } : null;
}

// Only convert dates near the requested window; older dates are counted to keep
// occurrence numbers stable. The caller restricts calendar requests to one month.
export function occurrencesBetween(schedule: Schedule, from: number, to: number, maxOffset = Infinity) {
	const occurrences: { offset: number; schedule: Schedule }[] = [];
	rule(schedule).all((date, offset) => {
		const seconds = date.getTime() / 1000;
		if (offset >= maxOffset || seconds > to + 86400) return false;
		if (seconds >= from - schedule.minutes * 60 - 86400) {
			const occurrence = { ...schedule, start: date.toISOString().slice(0, 16) };
			const start = startSeconds(occurrence);
			if (start < to && start + schedule.minutes * 60 > from) occurrences.push({ offset, schedule: occurrence });
		}
		return true;
	});
	return occurrences;
}

export function occurrenceCount(schedule: Schedule): number | null {
	if (schedule.repeat === 'none') return 1;
	if (schedule.count) return schedule.count;
	if (!schedule.until) return null;
	return rule(schedule).all().length;
}

export function repeatLabel(schedule: Schedule) {
	if (schedule.repeat === 'none') return '';
	const date = Temporal.PlainDateTime.from(schedule.start);
	const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
		floating(schedule.start),
	);
	const ordinal = schedule.ordinal ?? position(date);
	const nth = ordinal === -1 ? 'last' : ['first', 'second', 'third', 'fourth'][ordinal - 1];
	const pattern =
		schedule.repeat === 'ordinal'
			? `The ${nth} ${weekday} of every ${schedule.interval === 1 ? 'month' : `${schedule.interval} months`}`
			: schedule.repeat === 'monthly'
				? `Every ${schedule.interval} month(s) on day ${date.day}`
				: schedule.repeat === 'weekly'
					? schedule.interval === 1
						? `Every ${weekday}`
						: `Every ${schedule.interval} weeks on ${weekday}`
					: `Every ${schedule.interval} day(s)`;
	return `${pattern}${schedule.until ? ` through ${schedule.until}` : schedule.count ? `, ${schedule.count} occurrences` : ''}`;
}
