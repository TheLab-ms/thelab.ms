import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Member, MemberEvent } from '../src/lib.ts';
import { resetDB } from './helpers.ts';

// The compiler derives each expected column from the row type, so these maps
// always describe src/lib.ts; the test then compares them with the migrations.
type Column<T> = `${null extends T ? 'NULL' : 'NOT NULL'} ${NonNullable<T> extends number ? 'INTEGER' : 'TEXT'}`;
type Columns<Row> = { [K in keyof Row]-?: Column<Row[K]> };

const tables = {
  members: {
    member_id: 'NOT NULL TEXT', discord_user_id: 'NULL TEXT', discord_username: 'NOT NULL TEXT', discord_email: 'NOT NULL TEXT',
    email: 'NULL TEXT', waiver_name: 'NOT NULL TEXT', billing_name: 'NOT NULL TEXT', billing_email: 'NOT NULL TEXT',
    name_override: 'NOT NULL TEXT', notes: 'NOT NULL TEXT', fob_id: 'NULL INTEGER', non_billable: 'NOT NULL INTEGER',
    legacy_billing: 'NOT NULL INTEGER', metadata_version: 'NOT NULL INTEGER', created: 'NOT NULL INTEGER',
    bill_annually: 'NOT NULL INTEGER', discount_type: 'NOT NULL TEXT', stripe_customer_id: 'NULL TEXT',
    stripe_subscription_id: 'NULL TEXT', stripe_subscription_state: 'NULL TEXT', legacy_waiver_signed: 'NOT NULL INTEGER',
    stripe_sync_version: 'NOT NULL INTEGER', waiver_signed: 'NOT NULL INTEGER',
  } satisfies Columns<Member>,
  member_events: {
    id: 'NOT NULL INTEGER', created: 'NOT NULL INTEGER', member_id: 'NULL TEXT', event_type: 'NOT NULL TEXT',
    details: 'NOT NULL TEXT', source_event_id: 'NULL TEXT',
  } satisfies Columns<MemberEvent>,
};

describe('Row types', () => {
  beforeAll(resetDB);

  it.each(Object.entries(tables))('match the migrated %s table', async (table, expected) => {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string; type: string; notnull: number; pk: number }>();
    // STRICT tables reject NULL primary keys even without an explicit NOT NULL.
    const actual = Object.fromEntries(results.map(column => [column.name, `${column.notnull || column.pk ? 'NOT NULL' : 'NULL'} ${column.type}`]));
    expect(actual).toEqual(expected);
  });
});
