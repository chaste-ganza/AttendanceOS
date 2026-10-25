"""
rfid_test.py — Tests for rfid_service.py.

The reader is opened by the browser (Web Serial), so there is no serial
listener to test here: card taps arrive as plain UID strings.

These tests run against an in-memory SQLite database with minimal fixture
data and need no hardware.

Run with:
    python rfid_test.py
"""

import sqlite3
from datetime import datetime, timezone
from database import create_tables
from rfid_service import (
    normalize_uid,
    find_student_by_uid, find_student_by_id,
    handle_attendance_scan,
    assign_card, reassign_card, unassign_card,
    LookupStatus, ScanOutcome, AssignmentOutcome,
)


# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

_passed = 0
_failed = 0
_results = []


def _run(label, fn):
    global _passed, _failed
    try:
        fn()
        _passed += 1
        _results.append(("PASS", label, ""))
        print(f"  PASS  {label}")
    except AssertionError as e:
        _failed += 1
        _results.append(("FAIL", label, str(e)))
        print(f"  FAIL  {label}")
        if str(e):
            print(f"        {e}")
    except Exception as e:
        _failed += 1
        _results.append(("FAIL", label, f"{type(e).__name__}: {e}"))
        print(f"  FAIL  {label}")
        print(f"        {type(e).__name__}: {e}")


def section(title):
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


# ---------------------------------------------------------------------------
# In-memory DB fixture for service tests
# ---------------------------------------------------------------------------

def make_db():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    create_tables(conn)
    conn.commit()
    return conn


# Patch rfid_service to use an in-memory connection.
# rfid_service calls get_connection() at runtime (not at import time),
# so we patch the name inside the rfid_service module's own namespace.
_DB = make_db()


class _UnclosableConnection:
    """
    Wraps a sqlite3 connection and ignores close() calls.
    Used in tests so the service's finally: conn.close() does not
    destroy the shared in-memory database between test calls.
    All other attribute accesses are forwarded to the real connection.
    """
    def __init__(self, conn):
        self._conn = conn

    def close(self):
        pass  # intentionally a no-op

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def __enter__(self):
        return self._conn.__enter__()

    def __exit__(self, *args):
        return self._conn.__exit__(*args)


def _mem_connection():
    """Return the shared in-memory connection (close() is suppressed)."""
    _DB.execute("PRAGMA foreign_keys = ON")
    _DB.row_factory = sqlite3.Row
    return _UnclosableConnection(_DB)


import rfid_service as _svc
import database as _db_mod

# Save originals so we can restore after tests.
_orig_db_get_connection  = _db_mod.get_connection
_orig_svc_get_connection = _svc.get_connection

# Patch the reference inside rfid_service's own namespace.
_svc.get_connection = _mem_connection


# Seed minimal fixture data into the in-memory DB.
def _seed():
    cur = _DB.cursor()

    # Class
    cur.execute("INSERT INTO classes (id, name) VALUES (1, 'Y1B')")

    # Subject
    cur.execute("INSERT INTO subjects (id, name, code) VALUES (1, 'Mathematics', 'MATH')")

    # Teacher
    cur.execute(
        "INSERT INTO teachers (id, name, username, status, created_at) "
        "VALUES (1, 'Teacher One', 'teacher1', 'active', ?)", (now(),)
    )

    # Students
    # s1 — active, has card A96E9504
    cur.execute(
        "INSERT INTO students (id, first_name, last_name, registration_number, "
        "rfid_uid, class_id, status, created_at) "
        "VALUES (1, 'Alice', 'Smith', 'REG001', 'A96E9504', 1, 'active', ?)",
        (now(),)
    )
    # s2 — active, has card AB529E04
    cur.execute(
        "INSERT INTO students (id, first_name, last_name, registration_number, "
        "rfid_uid, class_id, status, created_at) "
        "VALUES (2, 'Bob', 'Jones', 'REG002', 'AB529E04', 1, 'active', ?)",
        (now(),)
    )
    # s3 — active, NO card
    cur.execute(
        "INSERT INTO students (id, first_name, last_name, registration_number, "
        "rfid_uid, class_id, status, created_at) "
        "VALUES (3, 'Carol', 'Lee', 'REG003', NULL, 1, 'active', ?)",
        (now(),)
    )
    # s4 — INACTIVE, has card 594AB9D4
    cur.execute(
        "INSERT INTO students (id, first_name, last_name, registration_number, "
        "rfid_uid, class_id, status, created_at) "
        "VALUES (4, 'Dave', 'Old', 'REG004', '594AB9D4', 1, 'inactive', ?)",
        (now(),)
    )

    # OPEN session
    cur.execute(
        "INSERT INTO attendance_sessions "
        "(id, class_id, teacher_id, subject_id, session_date, status, "
        " opened_at, created_at) "
        "VALUES (1, 1, 1, 1, '2026-10-07', 'OPEN', ?, ?)",
        (now(), now())
    )

    # CLOSED session
    cur.execute(
        "INSERT INTO attendance_sessions "
        "(id, class_id, session_date, status, created_at) "
        "VALUES (2, 1, '2026-10-07', 'CLOSED', ?)",
        (now(),)
    )

    _DB.commit()


_seed()


# ============================================================================
# SECTION 1 — UID normalization
# ============================================================================

section("1. UID NORMALIZATION")


def test_already_clean():
    assert normalize_uid("A96E9504") == "A96E9504"


def test_lowercase():
    assert normalize_uid("a96e9504") == "A96E9504"


def test_spaces():
    assert normalize_uid("a9 6e 95 04") == "A96E9504"


def test_whitespace():
    assert normalize_uid("  A96E9504\n") == "A96E9504"


def test_mixed():
    assert normalize_uid("Ab 52 9E 04") == "AB529E04"


_run("Already normalized", test_already_clean)
_run("Lowercase UID", test_lowercase)
_run("Spaces in UID", test_spaces)
_run("Leading/trailing whitespace", test_whitespace)
_run("Mixed case + spaces", test_mixed)




# ============================================================================
# SECTION 2 — Service: find_student_by_uid
# ============================================================================

section("2. SERVICE — find_student_by_uid")


def test_find_known_uid():
    r = find_student_by_uid("A96E9504")
    assert r.status == LookupStatus.FOUND
    assert r.first_name == "Alice"
    assert r.student_id == 1


def test_find_uid_normalizes():
    r = find_student_by_uid("a9 6e 95 04")
    assert r.status == LookupStatus.FOUND
    assert r.uid == "A96E9504"


def test_find_unknown_uid():
    r = find_student_by_uid("DEADBEEF")
    assert r.status == LookupStatus.NOT_FOUND
    assert r.student_id is None


def test_find_inactive_student_uid():
    r = find_student_by_uid("594AB9D4")
    assert r.status == LookupStatus.INACTIVE
    assert r.first_name == "Dave"


def test_find_student_by_id_found():
    r = find_student_by_id(2)
    assert r is not None
    assert r.first_name == "Bob"
    assert r.uid == "AB529E04"


def test_find_student_by_id_no_card():
    r = find_student_by_id(3)
    assert r is not None
    assert r.uid == ""  # Carol has no card


def test_find_student_by_id_not_found():
    r = find_student_by_id(99999)
    assert r is None


_run("find_student_by_uid — known UID returns FOUND", test_find_known_uid)
_run("find_student_by_uid — normalizes raw UID", test_find_uid_normalizes)
_run("find_student_by_uid — unknown UID returns NOT_FOUND", test_find_unknown_uid)
_run("find_student_by_uid — inactive student returns INACTIVE", test_find_inactive_student_uid)
_run("find_student_by_id — found with card", test_find_student_by_id_found)
_run("find_student_by_id — student with no card", test_find_student_by_id_no_card)
_run("find_student_by_id — not found returns None", test_find_student_by_id_not_found)


# ============================================================================
# SECTION 3 — Service: handle_attendance_scan
# ============================================================================

section("3. SERVICE — handle_attendance_scan")


def test_attendance_recorded():
    r = handle_attendance_scan("A96E9504", session_id=1)
    assert r.outcome == ScanOutcome.SUCCESS
    assert r.student_id == 1
    assert r.first_name == "Alice"
    assert r.attendance_time is not None


def test_attendance_duplicate_rejected():
    """Same student scanning twice in the same session must return DUPLICATE."""
    r = handle_attendance_scan("A96E9504", session_id=1)
    assert r.outcome == ScanOutcome.DUPLICATE
    assert r.student_id == 1


def test_attendance_second_student():
    """A different student can attend the same session."""
    r = handle_attendance_scan("AB529E04", session_id=1)
    assert r.outcome == ScanOutcome.SUCCESS
    assert r.student_id == 2


def test_attendance_unknown_card():
    """An unknown UID must NOT create any record — returns UNKNOWN_CARD."""
    r = handle_attendance_scan("DEADBEEF", session_id=1)
    assert r.outcome == ScanOutcome.UNKNOWN_CARD
    # Verify no attendance row was created.
    cur = _DB.cursor()
    cur.execute("SELECT COUNT(*) FROM attendance WHERE session_id = 1")
    count = cur.fetchone()[0]
    # Only Alice and Bob should be there (from tests above).
    assert count == 2, f"Expected 2 attendance rows, got {count}"


def test_attendance_inactive_student():
    # Inactive student UID → the card is not assigned to an active student
    # so it comes back as UNKNOWN_CARD (status=INACTIVE maps to UNKNOWN_CARD
    # in the new ScanOutcome because inactive students cannot attend).
    r = handle_attendance_scan("594AB9D4", session_id=1)
    assert r.outcome == ScanOutcome.UNKNOWN_CARD


def test_attendance_closed_session():
    """A CLOSED session must not accept attendance."""
    r = handle_attendance_scan("A96E9504", session_id=2)
    assert r.outcome == ScanOutcome.NO_OPEN_SESSION


def test_attendance_nonexistent_session():
    r = handle_attendance_scan("A96E9504", session_id=99999)
    assert r.outcome == ScanOutcome.ERROR


_run("Attendance recorded for known student in OPEN session",
     test_attendance_recorded)
_run("Duplicate scan returns DUPLICATE",
     test_attendance_duplicate_rejected)
_run("Different student can attend same session",
     test_attendance_second_student)
_run("Unknown card returns UNKNOWN_CARD (no record created)",
     test_attendance_unknown_card)
_run("Inactive student UID returns UNKNOWN_CARD",
     test_attendance_inactive_student)
_run("CLOSED session returns NO_OPEN_SESSION",
     test_attendance_closed_session)
_run("Non-existent session returns ERROR",
     test_attendance_nonexistent_session)


# ============================================================================
# SECTION 4 — Service: assign_card
# ============================================================================

section("4. SERVICE — assign_card")


def test_assign_to_student_without_card():
    """Carol (id=3) has no card — assign a new UID."""
    r = assign_card("NEWCARD1", student_id=3)
    assert r.success(), f"Expected success, got: {r}"
    assert r.outcome == AssignmentOutcome.ASSIGNED
    # Verify in DB.
    cur = _DB.cursor()
    cur.execute("SELECT rfid_uid FROM students WHERE id = 3")
    assert cur.fetchone()[0] == "NEWCARD1"


def test_assign_idempotent():
    """Assigning the same UID a second time to the same student succeeds."""
    r = assign_card("NEWCARD1", student_id=3)
    assert r.success()
    assert r.outcome == AssignmentOutcome.ASSIGNED


def test_assign_uid_already_taken():
    """UID belonging to another student returns UID_TAKEN — not silently moved."""
    r = assign_card("A96E9504", student_id=3)  # A96E9504 belongs to Alice
    assert r.outcome == AssignmentOutcome.UID_TAKEN
    assert r.previous_owner_id == 1


def test_assign_student_already_has_card():
    """Student already has a different card — returns UID_TAKEN."""
    r = assign_card("BRANDNEW", student_id=1)  # Alice already has A96E9504
    assert r.outcome == AssignmentOutcome.UID_TAKEN


def test_assign_inactive_student():
    r = assign_card("FRESHCARD", student_id=4)
    assert r.outcome == AssignmentOutcome.STUDENT_INACTIVE


def test_assign_nonexistent_student():
    r = assign_card("FRESHCARD", student_id=99999)
    assert r.outcome == AssignmentOutcome.STUDENT_NOT_FOUND


_run("Assign card to student with no card", test_assign_to_student_without_card)
_run("Assign same card again is idempotent", test_assign_idempotent)
_run("Assign UID owned by another student returns UID_TAKEN",
     test_assign_uid_already_taken)
_run("Assign when student already has different card returns UID_TAKEN",
     test_assign_student_already_has_card)
_run("Assign to inactive student returns STUDENT_INACTIVE",
     test_assign_inactive_student)
_run("Assign to nonexistent student returns STUDENT_NOT_FOUND",
     test_assign_nonexistent_student)


# ============================================================================
# SECTION 5 — Service: reassign_card
# ============================================================================

section("5. SERVICE — reassign_card")


def test_reassign_from_one_student_to_another():
    """
    Move A96E9504 from Alice (id=1) to Bob (id=2).
    Bob currently has AB529E04.
    After reassignment: Bob has A96E9504, Alice has NULL, Bob's old card
    (AB529E04) should be NULL because Bob's rfid_uid is overwritten.
    """
    r = reassign_card("A96E9504", student_id=2)
    assert r.success(), f"Expected success, got: {r}"
    assert r.outcome == AssignmentOutcome.REASSIGNED
    assert r.previous_owner_id == 1   # Alice was the previous owner

    cur = _DB.cursor()
    cur.execute("SELECT rfid_uid FROM students WHERE id = 2")
    assert cur.fetchone()[0] == "A96E9504", "Bob should now have A96E9504"

    cur.execute("SELECT rfid_uid FROM students WHERE id = 1")
    assert cur.fetchone()[0] is None, "Alice should have no card now"


def test_reassign_unowned_uid():
    """Reassign a UID that is not owned by anyone (no previous owner)."""
    r = reassign_card("ORPHANCARD", student_id=3)
    assert r.success()
    assert r.previous_owner_id is None


def test_reassign_inactive_student():
    r = reassign_card("SOMECARD", student_id=4)
    assert r.outcome == AssignmentOutcome.STUDENT_INACTIVE


def test_reassign_nonexistent_student():
    r = reassign_card("SOMECARD", student_id=99999)
    assert r.outcome == AssignmentOutcome.STUDENT_NOT_FOUND


_run("Reassign card from one student to another (clears old owner)",
     test_reassign_from_one_student_to_another)
_run("Reassign unowned UID (no previous owner)", test_reassign_unowned_uid)
_run("Reassign to inactive student returns STUDENT_INACTIVE",
     test_reassign_inactive_student)
_run("Reassign to nonexistent student returns STUDENT_NOT_FOUND",
     test_reassign_nonexistent_student)


# ============================================================================
# SECTION 6 — Service: unassign_card
# ============================================================================

section("6. SERVICE — unassign_card")


def test_unassign_card():
    """Remove the card from Carol (id=3)."""
    # First confirm Carol has a card (assigned in section 7).
    cur = _DB.cursor()
    cur.execute("SELECT rfid_uid FROM students WHERE id = 3")
    before = cur.fetchone()[0]
    assert before is not None, "Carol should have a card before unassign"

    r = unassign_card(student_id=3)
    assert r.success()
    assert r.outcome == AssignmentOutcome.UNASSIGNED

    cur.execute("SELECT rfid_uid FROM students WHERE id = 3")
    after = cur.fetchone()[0]
    assert after is None, "Carol should have no card after unassign"


def test_unassign_nonexistent_student():
    r = unassign_card(student_id=99999)
    assert r.outcome == AssignmentOutcome.STUDENT_NOT_FOUND


_run("Unassign card sets rfid_uid to NULL", test_unassign_card)
_run("Unassign nonexistent student returns STUDENT_NOT_FOUND",
     test_unassign_nonexistent_student)


# ============================================================================
# SECTION 7 — No device_id or devices table anywhere in service
# ============================================================================

section("7. SERVICE — NO DEVICE REFERENCES")


def test_no_devices_table_queried():
    """The rfid_service module must not reference the devices table."""
    import inspect
    import rfid_service
    source = inspect.getsource(rfid_service)
    assert "devices" not in source, (
        "'devices' table reference found in rfid_service.py — should not exist"
    )


def test_no_device_id_in_service():
    """rfid_service must not use device_id anywhere."""
    import inspect
    import rfid_service
    source = inspect.getsource(rfid_service)
    assert "device_id" not in source, (
        "'device_id' reference found in rfid_service.py — should not exist"
    )


_run("rfid_service.py has no 'devices' table reference",
     test_no_devices_table_queried)
_run("rfid_service.py has no 'device_id' reference",
     test_no_device_id_in_service)


# ---------------------------------------------------------------------------
# Restore original get_connection so other tools work normally.
# ---------------------------------------------------------------------------
_svc.get_connection = _orig_svc_get_connection


# ---------------------------------------------------------------------------
# Final report
# ---------------------------------------------------------------------------

total = _passed + _failed
print(f"\n{'=' * 60}")
print(f"  RESULTS: {_passed} passed, {_failed} failed, {total} total")
print(f"{'=' * 60}")

if _failed > 0:
    print("\n  FAILURES:")
    for status, label, detail in _results:
        if status == "FAIL":
            print(f"    x  {label}")
            if detail:
                print(f"       {detail}")
    raise SystemExit(1)
else:
    print("\n  All tests passed.")
