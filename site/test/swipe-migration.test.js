import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { EdgeSync } from '../src/membership.js';

describe('Swipe history migration', () => {
	beforeEach(async () => {
		await reset();
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(m => m.name < '0005'));
	});

	it('preserves all existing evidence and IDs, recovers missing history, and deduplicates retries', async () => {
		await env.DB.exec("INSERT INTO members(member_id, fob_id) VALUES ('old-owner', 7), ('deleted-owner', 8)");
		const swipes = [
			['live', 'old-owner', 7], ['conway:legacy/uid', 'old-owner', 7],
			['deleted', 'deleted-owner', 8], ['unknown', null, 99],
			['history-only', 'old-owner', 7], ['edge-only', 'old-owner', 7],
		];
		for (const [id, owner, fob] of swipes) {
			await env.DB.prepare(`INSERT INTO edge_swipes VALUES (?, '2001-01-01T00:00:00.123Z', 'Door Ω', ?, 0, ?)`)
				.bind(id, fob, owner).run();
		}
		await env.DB.exec("DELETE FROM edge_swipes WHERE id = 'history-only'");
		await env.DB.exec(`DELETE FROM member_events WHERE json_extract(details, '$.id') = 'edge-only'`);
		await env.DB.exec("DELETE FROM members WHERE member_id = 'deleted-owner'");
		await env.DB.exec("UPDATE members SET fob_id = NULL WHERE member_id = 'old-owner'");
		await env.DB.exec("INSERT INTO members(member_id, fob_id) VALUES ('current-owner', 7)");
		// Old Conway exports contain numeric history IDs as strings. Even a
		// collision with a swipe ID must not turn them into deduplication keys.
		await env.DB.prepare(`INSERT INTO member_events(id, created, member_id, event_type, details)
			VALUES (500, 100, 'old-owner', 'ConwayEvent', ?)`)
			.bind(JSON.stringify({ id: 'live', event: 'FobSwipe', details: '{"uid":"live"}' })).run();
		await env.DB.prepare(`INSERT INTO member_events(event_type, details) VALUES
			('FobSwipe', '{}'), ('FobSwipe', '{"id":null}'), ('FobSwipe', '{"id":123}'), ('FobSwipe', '{"id":""}')`).run();
		const original = (await env.DB.prepare('SELECT * FROM member_events ORDER BY id').all()).results;
		await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
		const upgraded = (await env.DB.prepare('SELECT * FROM member_events ORDER BY id').all()).results;
		expect(upgraded.slice(0, original.length).map(({ source_event_id, ...row }) => row)).toEqual(original);
		expect(upgraded).toHaveLength(original.length + 1);
		for (const [id, owner] of swipes) {
			const event = upgraded.find(row => row.source_event_id === id);
			expect(event).toMatchObject({ member_id: id === 'deleted' ? null : owner, created: 978307200, event_type: 'FobSwipe' });
			expect(JSON.parse(event.details)).toMatchObject({ id, time: '2001-01-01T00:00:00.123Z', controller: 'Door Ω', allowed: 0 });
		}
		expect(upgraded.filter(row => row.id >= 500 && row.id <= 504).map(row => row.source_event_id)).toEqual([null, null, null, null, null]);
		expect(upgraded.at(-1).id).toBeGreaterThan(504);
		expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE name IN ('edge_swipes', 'edge_swipe_history')").all()).results).toEqual([]);
		expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
		// Use the live writer after upgrade. Changed ownership and details on a
		// redelivery must not overwrite any migrated event or allocate a new row.
		await EdgeSync.prototype.importSwipes.call({ env }, swipes.filter(([id]) => !id.startsWith('conway:'))
			.map(([id]) => ({ id, time: new Date().toISOString(), controller: 'changed', fob: 7, allowed: true })));
		expect((await env.DB.prepare('SELECT * FROM member_events ORDER BY id').all()).results).toEqual(upgraded);
	});

	it('fails atomically on ambiguous source IDs before dropping the duplicate store', async () => {
		await env.DB.exec(`INSERT INTO edge_swipes VALUES ('duplicate', '2001-01-01T00:00:00Z', 'door', 7, 1, NULL)`);
		await env.DB.exec(`INSERT INTO member_events(event_type, details) VALUES ('FobSwipe', '{"id":"duplicate"}')`);
		const original = (await env.DB.prepare('SELECT * FROM member_events').all()).results;
		await expect(applyD1Migrations(env.DB, env.TEST_MIGRATIONS)).rejects.toThrow();
		expect((await env.DB.prepare('SELECT * FROM member_events').all()).results).toEqual(original);
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM edge_swipes').first()).n).toBe(1);
		expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'edge_swipe_history'").first()).not.toBeNull();
	});
});
