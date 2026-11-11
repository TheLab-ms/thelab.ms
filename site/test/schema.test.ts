import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
	CalendarEvent,
	CalendarOverride,
	CalendarRSVP,
	CalendarSchedule,
	Member,
	MemberEvent,
	WalletEntry,
} from '../src/lib.ts';
import { resetDB } from './helpers.ts';

// The compiler derives each expected column from the row type, so these maps
// always describe src/lib.ts; the test then compares them with the migrations.
type Column<T> = `${null extends T ? 'NULL' : 'NOT NULL'} ${NonNullable<T> extends number ? 'INTEGER' : 'TEXT'}`;
type Columns<Row> = { [K in keyof Row]-?: Column<Row[K]> };

const tables = {
	members: {
		member_id: 'NOT NULL TEXT',
		discord_user_id: 'NULL TEXT',
		discord_username: 'NOT NULL TEXT',
		discord_email: 'NOT NULL TEXT',
		email: 'NULL TEXT',
		waiver_name: 'NOT NULL TEXT',
		billing_name: 'NOT NULL TEXT',
		billing_email: 'NOT NULL TEXT',
		name_override: 'NOT NULL TEXT',
		notes: 'NOT NULL TEXT',
		fob_id: 'NULL INTEGER',
		non_billable: 'NOT NULL INTEGER',
		legacy_billing: 'NOT NULL INTEGER',
		metadata_version: 'NOT NULL INTEGER',
		created: 'NOT NULL INTEGER',
		bill_annually: 'NOT NULL INTEGER',
		discount_type: 'NOT NULL TEXT',
		stripe_customer_id: 'NULL TEXT',
		stripe_subscription_id: 'NULL TEXT',
		stripe_subscription_state: 'NULL TEXT',
		legacy_waiver_signed: 'NOT NULL INTEGER',
		stripe_sync_version: 'NOT NULL INTEGER',
		waiver_signed: 'NOT NULL INTEGER',
		family_primary_id: 'NULL TEXT',
	} satisfies Columns<Member>,
	member_events: {
		id: 'NOT NULL INTEGER',
		created: 'NOT NULL INTEGER',
		member_id: 'NULL TEXT',
		event_type: 'NOT NULL TEXT',
		details: 'NOT NULL TEXT',
		source_event_id: 'NULL TEXT',
	} satisfies Columns<MemberEvent>,
	wallet_entries: {
		entry_id: 'NOT NULL INTEGER',
		member_id: 'NULL TEXT',
		created: 'NOT NULL INTEGER',
		amount: 'NOT NULL INTEGER',
		item: 'NOT NULL TEXT',
		key: 'NOT NULL TEXT',
		details: 'NOT NULL TEXT',
	} satisfies Columns<WalletEntry>,
	calendar_events: {
		event_id: 'NOT NULL TEXT',
		organizer_id: 'NULL TEXT',
		revision: 'NOT NULL TEXT',
		cancel_from: 'NULL INTEGER',
		created: 'NOT NULL INTEGER',
	} satisfies Columns<CalendarEvent>,
	calendar_schedules: {
		event_id: 'NOT NULL TEXT',
		first_occurrence: 'NOT NULL INTEGER',
		schedule: 'NOT NULL TEXT',
	} satisfies Columns<CalendarSchedule>,
	calendar_overrides: {
		event_id: 'NOT NULL TEXT',
		occurrence: 'NOT NULL INTEGER',
		schedule: 'NOT NULL TEXT',
	} satisfies Columns<CalendarOverride>,
	calendar_rsvps: {
		event_id: 'NOT NULL TEXT',
		occurrence: 'NOT NULL INTEGER',
		member_id: 'NOT NULL TEXT',
		created: 'NOT NULL INTEGER',
	} satisfies Columns<CalendarRSVP>,
};

describe('Row types', () => {
	beforeAll(resetDB);

	it.each(Object.entries(tables))('match the migrated %s table', async (table, expected) => {
		const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
			name: string;
			type: string;
			notnull: number;
			pk: number;
		}>();
		// STRICT tables reject NULL primary keys even without an explicit NOT NULL.
		const actual = Object.fromEntries(
			results.map(column => [column.name, `${column.notnull || column.pk ? 'NOT NULL' : 'NULL'} ${column.type}`]),
		);
		expect(actual).toEqual(expected);
	});
});

describe('Conway notes migration', () => {
	beforeAll(async () => {
		await reset();
		await applyD1Migrations(
			env.DB,
			env.TEST_MIGRATIONS.filter(migration => migration.name < '0016'),
		);
	});

	it('keeps only PayPal, Lifetime, and Conway discount details and changes nothing else', async () => {
		const conway = (fields: Record<string, string>) =>
			`Conway source metadata: ${JSON.stringify({ confirmed: '1', leadership: '0', id: '7', ...fields })}`;
		const cases = [
			[conway({ waiver: '1', fob_last_seen: '1700000000' }), ''],
			[
				`Paid {cash}\r\n\n${conway({ discount_type: 'Lifetime', paypal_subscription_id: 'I-1', paypal_price: '40' })}`,
				'Paid {cash}\n\nFrom Conway: Lifetime member; PayPal subscription I-1; PayPal price 40',
			],
			[
				conway({ discount_type: 'educator', discount_status: 'approved', heard_about: 'Reddit' }),
				'From Conway: educator discount (approved)',
			],
			[conway({ discount_type: 'student', discount_status: '' }), 'From Conway: student discount'],
			[conway({ discount_type: 'none', discount_status: '' }), ''],
			[`Fob returned\n\n${conway({ pronouns: 'they/them' })}`, 'Fob returned'],
			['Conway source metadata: {"broken"', 'Conway source metadata: {"broken"'],
			['Hand-written note', 'Hand-written note'],
		] as const;
		for (const [i, [notes]] of cases.entries())
			await env.DB.prepare('INSERT INTO members (email, notes, created) VALUES (?, ?, ?)')
				.bind(`member${i}@example.com`, notes, i)
				.run();
		const select = 'SELECT * FROM members ORDER BY created';
		const before = (await env.DB.prepare(select).all<Member>()).results;
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
		const after = (await env.DB.prepare(select).all<Member>()).results;
		expect(after.map(member => member.notes)).toEqual(cases.map(([, notes]) => notes));
		expect(after.map(({ notes: _, ...rest }) => rest)).toEqual(before.map(({ notes: _, ...rest }) => rest));
	});
});

describe('Family primary migration', () => {
	beforeAll(async () => {
		await reset();
		await applyD1Migrations(
			env.DB,
			env.TEST_MIGRATIONS.filter(migration => migration.name < '0015'),
		);
	});

	it('links Family discounts to their Conway root family member', async () => {
		const conway = (fields: Record<string, string>, before = '') =>
			`${before}Conway source metadata: ${JSON.stringify({ confirmed: '1', ...fields })}`;
		const rows = [
			['parent', '', conway({ id: '10' })],
			['child', 'family', conway({ id: '11', root_family_member: '10' }, 'Paid {by} parent\n\n')],
			['former', '', conway({ id: '12', root_family_member: '10' })],
			['unknown', 'family', conway({ id: '13', root_family_member: '99' })],
			['broken', 'family', 'Conway source metadata: {"id": "14", "root_family_member": "10"'],
			['family-root', 'family', conway({ id: '15' })],
			['chained', 'family', conway({ id: '16', root_family_member: '15' })],
		];
		for (const [name, discount, notes] of rows)
			await env.DB.prepare('INSERT INTO members (member_id, email, discount_type, notes) VALUES (?, ?, ?, ?)')
				.bind(name.padEnd(32, '0'), `${name}@example.com`, discount, notes)
				.run();
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
		const { results } = await env.DB.prepare(
			'SELECT email, family_primary_id FROM members WHERE family_primary_id IS NOT NULL',
		).all();
		expect(results).toEqual([{ email: 'child@example.com', family_primary_id: 'parent'.padEnd(32, '0') }]);
		const event = await env.DB.prepare(
			"SELECT member_id, details FROM member_events WHERE event_type = 'FamilyPrimaryChanged'",
		).first<{ member_id: string; details: string }>();
		expect(event?.member_id).toBe('child'.padEnd(32, '0'));
		expect(JSON.parse(event?.details ?? '')).toEqual({
			from: null,
			from_name: null,
			to: 'parent'.padEnd(32, '0'),
			to_name: 'parent@example.com',
		});
	});
});
