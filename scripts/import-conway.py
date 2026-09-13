#!/usr/bin/env python3
"""Validate Conway CSV exports and generate SQL for an empty, migrated D1 database.

Usage (run from the repository root):
    Requires Python 3.10+ linked to SQLite 3.42+, plus npm ci for Wrangler.

    1. Create an ignored conway-import/ directory. While signed into Conway as
       leadership, download these URLs to the corresponding filenames there:
           /admin/export/members        -> members.csv
           /admin/export/waivers        -> waivers.csv
           /admin/export/member_events  -> member_events.csv
           /admin/export/fob_swipes     -> fob_swipes.csv
       Pause Conway writes during export so the four files form one snapshot.

    2. Generate SQL; this validates all input against the repository's D1 schema
       in an in-memory SQLite database. It does not contact Cloudflare:
           python3 scripts/import-conway.py conway-import --output conway-import/import.sql
       The output file must not already exist. To use a reproducible history
       window, append --as-of 2026-09-13T00:00:00Z (timezone required).

    3. Apply to an empty local database with the current schema:
           npm run db:local
           npx wrangler d1 execute thelab-membership --local --file conway-import/import.sql
       For production, configure the database ID in wrangler.jsonc, then run:
           npx wrangler d1 migrations apply thelab-membership --remote
           npx wrangler d1 execute thelab-membership --remote --file conway-import/import.sql
       Pause destination app writes during import. This is a one-time bootstrap:
       nonempty destinations and repeat imports are rejected, not upserted. If a
       local import is interrupted, recreate the disposable database and retry.

Scope and mapping:
    Imports every member and waiver, plus events and swipes within the inclusive
    90 * 24 hour window ending at --as-of (default: now). Printed counts include
    excluded history, unknown member links, and legacy billing/family/discount
    cases. Invalid rows, conflicting identities, or missing linked waivers stop
    generation before the output is written.

    PayPal subscriptions become legacy billing. Pending discounts and unsupported
    metadata, including family relationships, are preserved in notes; the new
    app does not implement Conway's family dependency rules. Review those cases
    before cutover. Waivers link by Conway's explicit member.waiver reference;
    their missing original text/checkbox evidence is labeled, never fabricated.
    Retain Conway's waiver_content database for the original versioned text.

    SQL does not call Stripe, Discord, queues, or Durable Objects. After cutover,
    use Full resync in /admin to deliver the imported fob eligibility to edgeproxy.
    See scripts/import-conway.md for full mappings and count-verification SQL.
"""

import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
TABLES = ("members", "waivers", "member_events", "edge_swipes", "fob_assignments", "fob_claims")
DISCOUNTS = {value.lower(): value for value in ("", "military", "retired", "firstResponder", "student", "family")}
LEGACY_WAIVER = (
    "# Imported Conway waiver record\n\n"
    "Conway recorded this signature's name, email, version and timestamp. "
    "Its CSV export did not include the original waiver text or individual checkbox evidence. "
    "Retain the original Conway waiver_content database for the versioned text."
)


def integer(value, label, minimum=0, maximum=2**53 - 1):
    if not re.fullmatch(r"[0-9]+", value) or not minimum <= int(value) <= maximum:
        raise ValueError(f"{label}: expected an integer from {minimum} through {maximum}")
    return int(value)


def flag(value, label):
    # SQLite's Go driver exports integer booleans as 0/1.
    return integer(value, label, maximum=1)


def rows(directory, table, required):
    path = directory / f"{table}.csv"
    with path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source, strict=True)
        header = reader.fieldnames or []
        if len(set(header)) != len(header) or not set(required) <= set(header):
            raise ValueError(f"{path}: expected unique headers including {', '.join(required)}")
        result = []
        for row in reader:
            if None in row or None in row.values() or any("\0" in value for value in row.values()):
                raise ValueError(f"{path}:{reader.line_num}: malformed CSV row")
            result.append(row)
        return result


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    return "'" + value.replace("'", "''") + "'"


def build_import(directory, as_of):
    if sqlite3.sqlite_version_info < (3, 42, 0):
        raise ValueError("Python must use SQLite 3.42+ (required by the D1 schema's timestamp defaults)")
    members = rows(directory, "members", (
        "id", "created", "email", "name", "name_override", "admin_notes", "waiver", "fob_id",
        "non_billable", "bill_annually", "discount_type", "discount_status", "paypal_subscription_id",
        "discord_user_id", "discord_username", "discord_email", "discord_last_synced",
        "stripe_customer_id", "stripe_subscription_id", "stripe_subscription_state",
    ))
    waivers = rows(directory, "waivers", ("id", "version", "created", "name", "email"))
    events = rows(directory, "member_events", ("id", "created", "member", "event", "details"))
    swipes = rows(directory, "fob_swipes", ("uid", "timestamp", "fob_id", "member", "allowed"))
    cutoff = as_of - 90 * 86400
    member_ids, waiver_owners, waiver_ids = {}, {}, set()
    stats = {"members": 0, "waivers": 0, "events": 0, "swipes": 0, "events_outside_window": 0,
             "swipes_outside_window": 0, "orphan_events": 0, "orphan_swipes": 0,
             "legacy_billing": 0, "family_relationships": 0, "pending_discounts": 0}

    # Validate against the real schema, including unique constraints and triggers,
    # before writing any output or contacting D1.
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for migration in sorted((ROOT / "migrations").glob("*.sql")):
        db.executescript(migration.read_text())
    statements = [
        "-- Conway import; apply schema migrations first. Requires an empty database.",
        "-- History window (inclusive Unix seconds): " + str(cutoff) + " through " + str(as_of),
        "CREATE TABLE _conway_import_guard (empty_database INTEGER CHECK (empty_database = 0));",
        "INSERT INTO _conway_import_guard VALUES (" + " + ".join(
            f"(SELECT count(*) FROM {table})" for table in TABLES) + ");",
    ]

    def insert(table, values):
        sql = f"INSERT INTO {table} ({', '.join(values)}) VALUES ({', '.join(literal(v) for v in values.values())});"
        if len(sql.encode()) > 100_000:
            raise ValueError(f"{table}: row exceeds D1's 100 KB SQL statement limit")
        try:
            db.execute(sql)
        except sqlite3.Error as error:
            identity = values.get("member_id") or values.get("id")
            raise ValueError(f"{table} {identity}: {error}") from error
        statements.append(sql)

    for row in members:
        source_id = str(integer(row["id"], "members.id", minimum=1))
        if source_id in member_ids:
            raise ValueError(f"Duplicate Conway member ID {source_id}")
        member_id = hashlib.sha256(f"conway:members:{source_id}".encode()).hexdigest()[:32]
        member_ids[source_id] = member_id
        waiver = row["waiver"]
        if waiver:
            waiver = str(integer(waiver, f"member {source_id} waiver", minimum=1))
            if waiver in waiver_owners:
                raise ValueError(f"Waiver {waiver} is linked to multiple members")
            waiver_owners[waiver] = member_id

        discord = row["discord_user_id"].strip() or None
        if discord and not re.fullmatch(r"[1-9][0-9]{16,19}", discord):
            raise ValueError(f"Member {source_id}: invalid Discord ID")
        customer = row["stripe_customer_id"].strip() or None
        subscription = row["stripe_subscription_id"].strip() or None
        if customer and not re.fullmatch(r"cus_[A-Za-z0-9]+", customer):
            raise ValueError(f"Member {source_id}: invalid Stripe customer ID")
        if subscription and (not customer or not re.fullmatch(r"sub_[A-Za-z0-9]+", subscription)):
            raise ValueError(f"Member {source_id}: invalid Stripe subscription/customer link")
        pending = row["discount_status"] == "requested"
        discount = row["discount_type"].strip().lower()
        if not pending and discount not in DISCOUNTS:
            raise ValueError(f"Member {source_id}: unsupported discount_type")
        # Preserve source-only metadata without inventing new application behavior.
        mapped = {"id", "created", "email", "name", "name_override", "admin_notes", "waiver", "fob_id",
                  "non_billable", "bill_annually", "discount_type", "discount_status", "discord_user_id",
                  "discord_username", "discord_email", "discord_last_synced", "stripe_customer_id",
                  "stripe_subscription_id", "stripe_subscription_state", "identifier", "access_status", "payment_status"}
        legacy = {key: value for key, value in row.items() if key not in mapped and value != ""}
        legacy["id"] = source_id
        if pending:
            legacy.update(discount_type=row["discount_type"], discount_status=row["discount_status"])
        notes = row["admin_notes"]
        notes += ("\n\n" if notes else "") + "Conway source metadata: " + json.dumps(legacy, ensure_ascii=False)
        legacy_billing = int(bool(row["paypal_subscription_id"].strip()))
        insert("members", {
            "member_id": member_id, "created": integer(row["created"], "members.created"),
            "email": row["email"].strip().lower() or None,
            "billing_name": row["name"], "name_override": row["name_override"], "notes": notes,
            "fob_id": (integer(row["fob_id"], "members.fob_id", maximum=4294967295) or None) if row["fob_id"] else None,
            "non_billable": flag(row["non_billable"], "members.non_billable"),
            "legacy_billing": legacy_billing, "bill_annually": flag(row["bill_annually"], "members.bill_annually"),
            "discount_type": "" if pending else DISCOUNTS[discount],
            "discord_user_id": discord, "discord_username": row["discord_username"],
            "discord_email": row["discord_email"].strip().lower(),
            "discord_last_synced": integer(row["discord_last_synced"], "members.discord_last_synced") if row["discord_last_synced"] else None,
            "stripe_customer_id": customer, "stripe_subscription_id": subscription,
            "stripe_subscription_state": row["stripe_subscription_state"] or None,
        })
        stats["members"] += 1
        stats["legacy_billing"] += legacy_billing
        stats["family_relationships"] += bool(row.get("root_family_member"))
        stats["pending_discounts"] += pending

    for row in waivers:
        source_id = integer(row["id"], "waivers.id", minimum=1)
        waiver_ids.add(str(source_id))
        insert("waivers", {
            "id": source_id, "member_id": waiver_owners.get(str(source_id)),
            "version": integer(row["version"], "waivers.version", minimum=1), "content": LEGACY_WAIVER,
            "created": integer(row["created"], "waivers.created"), "name": row["name"],
            "email": row["email"], "agreements": "[]",
        })
        stats["waivers"] += 1
    if missing := waiver_owners.keys() - waiver_ids:
        raise ValueError("Missing linked waivers: " + ", ".join(sorted(missing)))

    # The empty-target guard makes it safe to remove the synthetic registration
    # and signing events generated above. Keep only actual source history.
    db.execute("DELETE FROM member_events")
    statements.append("DELETE FROM member_events;")

    def member_link(value, stat):
        key = str(integer(value, "history.member", minimum=1)) if value else None
        link = member_ids.get(key)
        if link is None:
            stats[stat] += 1
        return link

    seen = set()
    for row in events:
        source_id = integer(row["id"], "member_events.id", minimum=1)
        if source_id in seen:
            raise ValueError(f"Duplicate Conway event ID {source_id}")
        seen.add(source_id)
        created = integer(row["created"], "member_events.created")
        if not cutoff <= created <= as_of:
            stats["events_outside_window"] += 1
            continue
        insert("member_events", {
            "created": created, "member_id": member_link(row["member"], "orphan_events"),
            "event_type": "ConwayEvent", "details": json.dumps(row, ensure_ascii=False),
        })
        stats["events"] += 1

    seen = set()
    for row in swipes:
        if not row["uid"] or row["uid"] in seen:
            raise ValueError("Missing or duplicate Conway swipe UID")
        seen.add(row["uid"])
        created = integer(row["timestamp"], "fob_swipes.timestamp")
        if not cutoff <= created <= as_of:
            stats["swipes_outside_window"] += 1
            continue
        insert("edge_swipes", {
            "id": "conway:" + row["uid"],
            "time": datetime.fromtimestamp(created, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "controller": row.get("controller") or ("Conway client " + row["fob_client"] if row.get("fob_client") else "Conway (unknown controller)"),
            "fob": integer(row["fob_id"], "fob_swipes.fob_id", minimum=1, maximum=4294967295),
            "allowed": flag(row["allowed"], "fob_swipes.allowed"),
            "member_id": member_link(row["member"], "orphan_swipes"),
        })
        stats["swipes"] += 1
    if db.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("Foreign-key validation failed")
    db.close()
    statements.append("DROP TABLE _conway_import_guard;")
    return "\n".join(statements) + "\n", stats


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory", type=Path, help="directory containing members.csv, waivers.csv, member_events.csv and fob_swipes.csv")
    parser.add_argument("--output", type=Path, required=True, help="SQL file to create (must not already exist)")
    parser.add_argument("--as-of", help="UTC ISO timestamp for the end of the 90-day window (default: now)")
    args = parser.parse_args()
    try:
        as_of = datetime.fromisoformat(args.as_of.replace("Z", "+00:00")) if args.as_of else datetime.now(timezone.utc)
        if as_of.tzinfo is None:
            raise ValueError("--as-of must include a timezone, e.g. 2026-09-13T00:00:00Z")
        sql, stats = build_import(args.directory, int(as_of.timestamp()))
        with args.output.open("x", encoding="utf-8") as output:
            output.write(sql)
    except (ValueError, OSError, csv.Error, sqlite3.Error) as error:
        parser.exit(1, f"Import failed: {error}\n")
    print(json.dumps(stats, indent=2))
    print(f"Validated SQL written to {args.output}")


if __name__ == "__main__":
    main()
