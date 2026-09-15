"""Regression tests for Conway CSV data that does not fit the new schema."""

import csv
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("import_conway", Path(__file__).with_name("import-conway.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class ImportConwayTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.members = [self.member(1), self.member(2)]
        self.waivers = [{"id": "2", "version": "1", "created": "100", "name": "Signer", "email": "1@example.org"}]

    def member(self, source_id, **values):
        row = dict.fromkeys((
            "id", "created", "email", "name", "name_override", "admin_notes", "waiver", "fob_id",
            "non_billable", "bill_annually", "discount_type", "discount_status", "paypal_subscription_id",
            "discord_user_id", "discord_username", "discord_email", "discord_last_synced",
            "stripe_customer_id", "stripe_subscription_id", "stripe_subscription_state",
        ), "")
        row.update(id=str(source_id), created="100", email=f"{source_id}@example.org",
                   non_billable="0", bill_annually="0")
        row.update(values)
        return row

    def build(self):
        for table, rows, headers in (
            ("members", self.members, self.members[0].keys()),
            ("waivers", self.waivers, self.waivers[0].keys()),
            ("member_events", [], ("id", "created", "member", "event", "details")),
            ("fob_swipes", [], ("uid", "timestamp", "fob_id", "member", "allowed")),
        ):
            with (self.directory / f"{table}.csv").open("w", newline="") as output:
                writer = csv.DictWriter(output, fieldnames=headers)
                writer.writeheader()
                writer.writerows(rows)
        return importer.build_import(self.directory, 200)

    def load(self):
        sql, stats = self.build()
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        for migration in sorted((importer.ROOT / "migrations").glob("*.sql")):
            db.executescript(migration.read_text())
        db.executescript(sql)
        self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        return db, stats

    def metadata(self, member):
        return json.loads(member["notes"].split("Conway source metadata: ", 1)[1])

    def test_missing_shared_waiver_preserves_eligibility_without_signature(self):
        for member in self.members:
            member["waiver"] = "1"
        db, stats = self.load()
        self.assertEqual(stats["missing_waiver_links"], 2)
        self.assertEqual(db.execute("SELECT count(*) FROM waivers").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT count(*) FROM waivers WHERE member_id IS NOT NULL").fetchone()[0], 0)
        for member in db.execute("SELECT * FROM members"):
            self.assertEqual(member["legacy_waiver_signed"], 1)
            self.assertEqual(member["waiver_name"], "")
            self.assertEqual(self.metadata(member)["waiver"], "1")
            self.assertEqual(self.metadata(member)["waiver_import_status"], "missing_from_export")

    def test_existing_waiver_links_and_missing_reference_is_preserved(self):
        self.members[0]["waiver"] = "2"
        self.members[1]["waiver"] = "78"
        db, stats = self.load()
        self.assertEqual(stats["missing_waiver_links"], 1)
        member = db.execute("SELECT * FROM members WHERE email = '1@example.org'").fetchone()
        self.assertEqual(member["waiver_name"], "Signer")
        self.assertEqual(member["legacy_waiver_signed"], 0)
        self.assertEqual(db.execute("SELECT member_id FROM waivers").fetchone()[0], member["member_id"])

    def test_stripe_and_legacy_billing_preserve_independent_waiver_status(self):
        self.members = []
        for state in ("active", "trialing", "past_due", "canceled", "unknown", ""):
            for paypal in ("", "I-LEGACY"):
                for waiver in ("", "1"):
                    source_id = len(self.members) + 1
                    self.members.append(self.member(
                        source_id, fob_id=str(source_id), waiver=waiver,
                        stripe_customer_id=f"cus_{source_id}", stripe_subscription_id=f"sub_{source_id}",
                        stripe_subscription_state=state, paypal_subscription_id=paypal,
                    ))
        db, _ = self.load()
        for source in self.members:
            member = db.execute("SELECT * FROM members WHERE email = ?", (source["email"],)).fetchone()
            self.assertEqual(member["stripe_customer_id"], source["stripe_customer_id"])
            self.assertEqual(member["stripe_subscription_id"], source["stripe_subscription_id"])
            self.assertEqual(member["stripe_subscription_state"], source["stripe_subscription_state"] or None)
            self.assertEqual(member["legacy_billing"], int(bool(source["paypal_subscription_id"])))
            self.assertEqual(member["legacy_waiver_signed"], int(bool(source["waiver"])))
            self.assertEqual(member["non_billable"], 0)

    def test_shared_existing_waiver_and_duplicate_waiver_ids_still_fail(self):
        for member in self.members:
            member["waiver"] = "2"
        with self.assertRaisesRegex(ValueError, "linked to multiple members"):
            self.build()
        self.waivers.append(dict(self.waivers[0]))
        with self.assertRaisesRegex(ValueError, "Duplicate Conway waiver ID"):
            self.build()

    def test_unsupported_discount_preserves_notes_and_supported_discount(self):
        self.members[0].update(discount_type="Lifetime", discount_status="approved", admin_notes="Original notes")
        self.members[1]["discount_type"] = "firstResponder"
        db, stats = self.load()
        self.assertEqual(stats["unsupported_discounts"], 1)
        members = db.execute("SELECT * FROM members ORDER BY email").fetchall()
        self.assertEqual(members[0]["discount_type"], "")
        self.assertTrue(members[0]["notes"].startswith("Original notes\n\n"))
        self.assertEqual(self.metadata(members[0])["discount_type"], "Lifetime")
        self.assertEqual(self.metadata(members[0])["discount_status"], "approved")
        self.assertEqual(members[1]["discount_type"], "firstResponder")

    def test_invalid_and_shared_discord_ids_are_preserved_without_linking(self):
        self.members[0]["discord_user_id"] = "123456789012345678"
        self.members[1]["discord_user_id"] = " 123456789012345678 "
        self.members.append(self.member(3, discord_user_id="some_username"))
        self.members.append(self.member(4, discord_user_id="234567890123456789"))
        db, stats = self.load()
        self.assertEqual(stats["invalid_discord_ids"], 1)
        self.assertEqual(stats["shared_discord_links"], 2)
        members = db.execute("SELECT * FROM members ORDER BY email").fetchall()
        for source, member in zip(self.members[:3], members[:3]):
            self.assertIsNone(member["discord_user_id"])
            self.assertEqual(self.metadata(member)["discord_user_id"], source["discord_user_id"])
        self.assertEqual(self.metadata(members[0])["discord_import_status"], "shared_id")
        self.assertEqual(self.metadata(members[2])["discord_import_status"], "invalid_id")
        self.assertEqual(members[3]["discord_user_id"], "234567890123456789")


if __name__ == "__main__":
    unittest.main()
