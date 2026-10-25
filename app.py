"""
app.py — Flask API for the RFID attendance prototype.

Architecture:
    The RFID reader is plugged into the teacher's own computer, not the
    machine running this server. The React app opens it with the Web Serial
    API, reads card UIDs in the browser and posts each one to POST /api/scan,
    which runs process_scan() and stores attendance.

    The server therefore never opens a serial port and has no notion of a
    "connected reader": any teacher can bring their own Arduino and connect
    it from their browser. Card assignment works the same way — the browser
    reads the UID and the server only checks (/api/cards/check) and writes
    (/api/cards/confirm) it.

Startup:
    python app.py

Configuration (environment variables or defaults):
    FLASK_HOST    host to bind                      (default: 127.0.0.1)
    FLASK_PORT    port to bind                      (default: 5000)
    FLASK_DEBUG   enable debug mode                 (default: 0)
"""

import os
import smtplib
from email.message import EmailMessage
from datetime import datetime, timezone

from flask import Flask, jsonify, request, session as login_session

from database          import initialize_database
from auth_service      import (
    authenticate_teacher, create_teacher, get_teacher,
    issue_reset_token, reset_teacher_password,
)
from rfid_service      import process_scan
from session_service   import (
    create_session, open_session, close_session, complete_session,
    get_session, get_open_session, list_sessions, get_session_attendance,
    SessionOutcome,
)
from card_management_service import (
    check_uid_for_assignment, confirm_assignment, cancel_assignment,
    create_student, update_student, get_student, list_students,
    students_with_cards, students_without_cards,
    CardCheckOutcome, StudentOutcome,
)

# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False
app.secret_key = os.environ.get("FLASK_SECRET_KEY") or os.urandom(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE", "0") == "1",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


@app.before_request
def require_teacher_session():
    if not request.path.startswith("/api/") or request.path == "/api/health":
        return None
    if request.endpoint in {
        "api_register", "api_login", "api_auth_me", "api_logout",
        "api_password_reset_request", "api_password_reset_complete",
    }:
        return None
    teacher_id = login_session.get("teacher_id")
    if not teacher_id or get_teacher(teacher_id) is None:
        login_session.clear()
        return _err("Authentication required.", 401)
    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok(data: dict, status: int = 200):
    return jsonify(data), status


def _err(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _session_outcome_to_status(outcome: SessionOutcome) -> int:
    if outcome in (
        SessionOutcome.CREATED,
        SessionOutcome.OPENED,
        SessionOutcome.CLOSED,
        SessionOutcome.COMPLETED,
        SessionOutcome.OK,
    ):
        return 200
    if outcome == SessionOutcome.NOT_FOUND:
        return 404
    return 400


# ---------------------------------------------------------------------------
# Teacher authentication
# ---------------------------------------------------------------------------

@app.route("/api/auth/register", methods=["POST"])
def api_register():
    body = request.get_json(silent=True) or {}
    teacher, message, status = create_teacher(
        body.get("email", ""), body.get("full_name", ""), body.get("password", "")
    )
    if teacher is None:
        return _err(message, status)
    login_session.clear()
    login_session["teacher_id"] = teacher["id"]
    login_session.permanent = True
    return _ok({"user": teacher, "message": message}, 201)


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip()
    password = body.get("password") or ""
    teacher = authenticate_teacher(email, password)
    if teacher is None:
        return _err("Invalid email or password.", 401)
    login_session.clear()
    login_session["teacher_id"] = teacher["id"]
    login_session.permanent = True
    return _ok({"user": teacher})


@app.route("/api/auth/me", methods=["GET"])
def api_auth_me():
    teacher_id = login_session.get("teacher_id")
    teacher = get_teacher(teacher_id) if teacher_id else None
    if teacher is None:
        login_session.clear()
        return _err("Not authenticated.", 401)
    return _ok({"user": teacher})


@app.route("/api/auth/logout", methods=["POST"])
def api_logout():
    login_session.clear()
    return _ok({"message": "Signed out."})


@app.route("/api/auth/password-reset", methods=["POST"])
def api_password_reset_request():
    smtp_host = os.environ.get("SMTP_HOST")
    if not smtp_host:
        return _err("Password reset email is not configured on this server.", 503)

    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    reset = issue_reset_token(email)
    if reset:
        base_url = os.environ.get("PUBLIC_BASE_URL", request.url_root.rstrip("/"))
        reset_url = f"{base_url.rstrip('/')}/reset-password?token={reset['token']}"
        message = EmailMessage()
        message["Subject"] = "AttendanceOS password reset"
        message["From"] = os.environ.get("SMTP_FROM", os.environ.get("SMTP_USERNAME", ""))
        message["To"] = reset["teacher"]["email"]
        message.set_content(
            "Use the following link to reset your AttendanceOS password. "
            "It expires in one hour.\n\n" + reset_url
        )
        try:
            with smtplib.SMTP(smtp_host, int(os.environ.get("SMTP_PORT", "587")), timeout=10) as smtp:
                if os.environ.get("SMTP_USE_TLS", "1") == "1":
                    smtp.starttls()
                username = os.environ.get("SMTP_USERNAME")
                password = os.environ.get("SMTP_PASSWORD")
                if username:
                    smtp.login(username, password or "")
                smtp.send_message(message)
        except (OSError, smtplib.SMTPException, ValueError):
            return _err("Password reset email could not be sent. Check the mail server configuration.", 503)

    return _ok({"message": "If an account exists with that email, a reset link will be sent."})


@app.route("/api/auth/password-reset/complete", methods=["POST"])
def api_password_reset_complete():
    body = request.get_json(silent=True) or {}
    token = body.get("reset_token") or ""
    new_password = body.get("new_password") or ""
    if not token:
        return _err("reset_token is required.", 400)
    success, message, status = reset_teacher_password(token, new_password)
    if not success:
        return _err(message, status)
    return _ok({"message": message})


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    """
    Simple JSON status page for the API host.
    The React SPA is served separately and talks to /api/*.
    """
    open_sess = get_open_session()
    return _ok({
        "app"         : "RFID Attendance Portal",
        "open_session": open_sess.to_dict() if open_sess else None,
    })


@app.route("/api/dashboard")
def api_dashboard():
    """Full dashboard snapshot: reader status + open session + today's sessions."""
    from datetime import date
    today = date.today().isoformat()
    today_sessions = list_sessions(session_date=today)
    open_sess      = get_open_session()

    return _ok({
        "open_session"  : open_sess.to_dict() if open_sess else None,
        "today_sessions": [s.to_dict() for s in today_sessions],
        "timestamp"     : _now_iso(),
    })


@app.route("/api/scan", methods=["POST"])
def api_record_scan():
    """
    Record attendance for a UID read by the browser's own reader.

    The teacher's computer owns the serial connection (Web Serial API), so
    each card tap arrives here as a plain UID. The same validation as the
    server-side listener applies: an OPEN session must exist, the card must
    belong to an active student in that class, and duplicates are rejected.

    Body (JSON):
        uid  str  required
    """
    body = request.get_json(silent=True) or {}
    uid = (body.get("uid") or "").strip()
    if not uid:
        return _err("uid is required", 400)
    return _ok(process_scan(uid).to_dict())


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

@app.route("/api/sessions", methods=["GET"])
def api_list_sessions():
    """
    List sessions.

    Query params:
        class_id    filter by class
        teacher_id  filter by teacher
        status      filter by status (SCHEDULED|OPEN|CLOSED|COMPLETED)
        date        filter by session_date (YYYY-MM-DD)
    """
    class_id     = request.args.get("class_id",    type=int)
    teacher_id   = request.args.get("teacher_id",  type=int)
    status       = request.args.get("status")
    session_date = request.args.get("date")

    sessions = list_sessions(
        class_id=class_id,
        teacher_id=teacher_id,
        status=status,
        session_date=session_date,
    )
    return _ok({"sessions": [s.to_dict() for s in sessions]})


@app.route("/api/sessions", methods=["POST"])
def api_create_session():
    """
    Create a new attendance session.

    Body (JSON):
        class_id      int  required
        session_date  str  optional (defaults to today)
        teacher_id    int  optional
        subject_id    int  optional
        start_time    str  optional  "HH:MM"
        end_time      str  optional  "HH:MM"
    """
    body = request.get_json(silent=True) or {}

    class_id = body.get("class_id")
    if not class_id:
        return _err("class_id is required", 400)

    result = create_session(
        class_id     = class_id,
        session_date = body.get("session_date"),
        teacher_id   = body.get("teacher_id") or login_session.get("teacher_id"),
        subject_id   = body.get("subject_id"),
        slot_id      = body.get("slot_id"),
        start_time   = body.get("start_time"),
        end_time     = body.get("end_time"),
        room         = body.get("room"),
    )

    if not result.success():
        return _err(result.message, 400)

    return _ok({
        "session": result.session.to_dict(),
        "message": result.message,
    }, 201)


@app.route("/api/sessions/<int:session_id>", methods=["GET"])
def api_get_session(session_id: int):
    """Return one session by id, including its attendance records."""
    session = get_session(session_id)
    if session is None:
        return _err(f"Session {session_id} not found", 404)

    attendance = get_session_attendance(session_id)
    return _ok({
        "session"   : session.to_dict(),
        "attendance": [a.to_dict() for a in attendance],
    })


@app.route("/api/sessions/<int:session_id>/open", methods=["POST"])
def api_open_session(session_id: int):
    """
    Open a session (SCHEDULED|CLOSED -> OPEN).

    Returns 409 if another session is already OPEN, with details of
    the conflicting session so the caller can close it first.
    """
    result = open_session(session_id)

    if result.outcome == SessionOutcome.NOT_FOUND:
        return _err(result.message, 404)

    if result.outcome == SessionOutcome.ALREADY_OPEN_EXISTS:
        return _ok({
            "outcome"    : result.outcome.value,
            "message"    : result.message,
            "session"    : result.session.to_dict() if result.session else None,
            "conflicting": result.conflicting.to_dict() if result.conflicting else None,
        }, 409)

    if not result.success():
        return _err(result.message, 400)

    return _ok({
        "outcome": result.outcome.value,
        "session": result.session.to_dict(),
        "message": result.message,
    })


@app.route("/api/sessions/<int:session_id>/close", methods=["POST"])
def api_close_session(session_id: int):
    """Close an OPEN session (OPEN -> CLOSED)."""
    result = close_session(session_id)

    if result.outcome == SessionOutcome.NOT_FOUND:
        return _err(result.message, 404)
    if not result.success():
        return _err(result.message, 400)

    return _ok({
        "outcome": result.outcome.value,
        "session": result.session.to_dict(),
        "message": result.message,
    })


@app.route("/api/sessions/<int:session_id>/complete", methods=["POST"])
def api_complete_session(session_id: int):
    """Permanently complete a session (OPEN|CLOSED -> COMPLETED)."""
    result = complete_session(session_id)

    if result.outcome == SessionOutcome.NOT_FOUND:
        return _err(result.message, 404)
    if not result.success():
        return _err(result.message, 400)

    return _ok({
        "outcome": result.outcome.value,
        "session": result.session.to_dict(),
        "message": result.message,
    })


@app.route("/api/sessions/<int:session_id>/attendance", methods=["GET"])
def api_session_attendance(session_id: int):
    """Return all attendance records for a session."""
    session = get_session(session_id)
    if session is None:
        return _err(f"Session {session_id} not found", 404)

    rows = get_session_attendance(session_id)
    return _ok({
        "session_id" : session_id,
        "count"      : len(rows),
        "attendance" : [r.to_dict() for r in rows],
    })


@app.route("/api/attendance", methods=["GET"])
def api_list_attendance():
    """List persisted attendance, optionally filtered by session or student."""
    from database import get_connection
    session_id = request.args.get("session_id", type=int)
    student_id = request.args.get("student_id", type=int)
    clauses = []
    params = []
    if session_id is not None:
        clauses.append("a.session_id = ?")
        params.append(session_id)
    if student_id is not None:
        clauses.append("a.student_id = ?")
        params.append(student_id)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT a.id, a.session_id, a.student_id, a.attendance_time, a.status, "
            "a.created_at, s.first_name, s.last_name, s.registration_number, s.rfid_uid "
            "FROM attendance a JOIN students s ON s.id = a.student_id "
            f"{where} ORDER BY a.attendance_time DESC",
            params,
        ).fetchall()
        records = []
        for row in rows:
            record = dict(row)
            record["full_name"] = f"{row['first_name']} {row['last_name']}".strip()
            records.append(record)
    finally:
        conn.close()
    return _ok({"attendance": records, "count": len(records)})


_TIMETABLE_SLOT_SELECT = """
    SELECT slot.id, slot.day_of_week, slot.class_id, cls.name AS class_name,
           slot.subject_id, sub.name AS subject, slot.teacher_id,
           teacher.name AS teacher_name, slot.room, slot.start_time,
           slot.end_time, slot.accent, slot.created_at
    FROM timetable_slots slot
    JOIN classes cls ON cls.id = slot.class_id
    JOIN subjects sub ON sub.id = slot.subject_id
    LEFT JOIN teachers teacher ON teacher.id = slot.teacher_id
"""


@app.route("/api/timetable-slots", methods=["GET", "POST"])
def api_timetable_slots():
    from database import get_connection
    if request.method == "GET":
        conn = get_connection()
        try:
            rows = conn.execute(
                _TIMETABLE_SLOT_SELECT +
                " ORDER BY CASE slot.day_of_week WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 "
                "WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 ELSE 5 END, slot.start_time"
            ).fetchall()
            return _ok({"slots": [dict(row) for row in rows]})
        finally:
            conn.close()

    body = request.get_json(silent=True) or {}
    day = (body.get("day_of_week") or "").strip().lower()
    if day not in {"monday", "tuesday", "wednesday", "thursday", "friday"}:
        return _err("day_of_week must be a weekday from monday to friday.", 400)
    required = ("class_id", "subject_id", "start_time", "end_time")
    if any(not body.get(key) for key in required):
        return _err("class_id, subject_id, start_time, and end_time are required.", 400)
    if body["end_time"] <= body["start_time"]:
        return _err("end_time must be later than start_time.", 400)
    conn = get_connection()
    try:
        with conn:
            cursor = conn.execute(
                "INSERT INTO timetable_slots (day_of_week, class_id, subject_id, teacher_id, "
                "room, start_time, end_time, accent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (day, body["class_id"], body["subject_id"], body.get("teacher_id"),
                 body.get("room"), body["start_time"], body["end_time"],
                 body.get("accent") or "indigo", _now_iso()),
            )
            slot_id = cursor.lastrowid
        row = conn.execute(_TIMETABLE_SLOT_SELECT + " WHERE slot.id = ?", (slot_id,)).fetchone()
        return _ok({"slot": dict(row)}, 201)
    except Exception as exc:
        return _err(f"Could not create timetable slot: {exc}", 400)
    finally:
        conn.close()


@app.route("/api/timetable-slots/<int:slot_id>", methods=["PATCH", "DELETE"])
def api_timetable_slot(slot_id: int):
    from database import get_connection
    conn = get_connection()
    try:
        row = conn.execute("SELECT id FROM timetable_slots WHERE id = ?", (slot_id,)).fetchone()
        if row is None:
            return _err(f"Timetable slot {slot_id} not found.", 404)
        if request.method == "DELETE":
            used = conn.execute(
                "SELECT COUNT(*) FROM attendance_sessions WHERE slot_id = ?", (slot_id,)
            ).fetchone()[0]
            if used:
                return _err(f"Cannot delete this slot: {used} session(s) refer to it.", 409)
            with conn:
                conn.execute("DELETE FROM timetable_slots WHERE id = ?", (slot_id,))
            return _ok({"message": f"Timetable slot {slot_id} deleted."})

        body = request.get_json(silent=True) or {}
        allowed = {"day_of_week", "class_id", "subject_id", "teacher_id", "room",
                   "start_time", "end_time", "accent"}
        updates = {key: body[key] for key in allowed if key in body}
        if "day_of_week" in updates:
            updates["day_of_week"] = str(updates["day_of_week"]).lower()
            if updates["day_of_week"] not in {"monday", "tuesday", "wednesday", "thursday", "friday"}:
                return _err("day_of_week must be a weekday from monday to friday.", 400)
        current = conn.execute(
            "SELECT start_time, end_time FROM timetable_slots WHERE id = ?", (slot_id,)
        ).fetchone()
        start_time = updates.get("start_time", current["start_time"])
        end_time = updates.get("end_time", current["end_time"])
        if end_time <= start_time:
            return _err("end_time must be later than start_time.", 400)
        if updates:
            clause = ", ".join(f"{key} = ?" for key in updates)
            with conn:
                conn.execute(
                    f"UPDATE timetable_slots SET {clause} WHERE id = ?",
                    [*updates.values(), slot_id],
                )
        updated = conn.execute(
            _TIMETABLE_SLOT_SELECT + " WHERE slot.id = ?", (slot_id,)
        ).fetchone()
        return _ok({"slot": dict(updated)})
    except Exception as exc:
        return _err(f"Could not update timetable slot: {exc}", 400)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Students
# ---------------------------------------------------------------------------

@app.route("/api/students", methods=["GET"])
def api_list_students():
    """
    List students.

    Query params:
        class_id    filter by class
        status      filter by status (active|inactive)
        has_card    filter by card presence (true|false)
    """
    class_id_str = request.args.get("class_id", type=int)
    status       = request.args.get("status")
    has_card_str = request.args.get("has_card")

    has_card = None
    if has_card_str is not None:
        has_card = has_card_str.lower() in ("1", "true", "yes")

    students = list_students(
        class_id=class_id_str,
        status=status,
        has_card=has_card,
    )
    return _ok({"students": [s.to_dict() for s in students]})


@app.route("/api/students", methods=["POST"])
def api_create_student():
    """
    Create a student.

    Body (JSON):
        first_name           str  required
        last_name            str  required
        registration_number  str  required
        class_id             int  optional
        rfid_uid             str  optional
    """
    body = request.get_json(silent=True) or {}

    first_name = (body.get("first_name") or "").strip()
    last_name  = (body.get("last_name")  or "").strip()
    reg_num    = (body.get("registration_number") or "").strip()

    if not first_name:
        return _err("first_name is required", 400)
    if not last_name:
        return _err("last_name is required", 400)
    if not reg_num:
        return _err("registration_number is required", 400)

    result = create_student(
        first_name          = first_name,
        last_name           = last_name,
        registration_number = reg_num,
        class_id            = body.get("class_id"),
        rfid_uid            = body.get("rfid_uid"),
    )

    if not result.success():
        status_code = 409 if result.outcome == StudentOutcome.DUPLICATE_REG_NUMBER else 400
        return _err(result.message, status_code)

    return _ok({
        "student": result.student.to_dict(),
        "message": result.message,
    }, 201)


@app.route("/api/students/<int:student_id>", methods=["GET"])
def api_get_student(student_id: int):
    """Return one student by id."""
    student = get_student(student_id)
    if student is None:
        return _err(f"Student {student_id} not found", 404)
    return _ok({"student": student.to_dict()})


@app.route("/api/students/<int:student_id>", methods=["PATCH"])
def api_update_student(student_id: int):
    """
    Update mutable student fields.

    Body (JSON): any subset of first_name, last_name,
                 registration_number, class_id, status.
    Note: rfid_uid is managed through /api/cards endpoints only.
    """
    body = request.get_json(silent=True) or {}

    result = update_student(
        student_id          = student_id,
        first_name          = body.get("first_name"),
        last_name           = body.get("last_name"),
        registration_number = body.get("registration_number"),
        class_id            = body.get("class_id"),
        status              = body.get("status"),
    )

    if result.outcome == StudentOutcome.NOT_FOUND:
        return _err(result.message, 404)
    if not result.success():
        return _err(result.message, 400)

    return _ok({
        "student": result.student.to_dict(),
        "message": result.message,
    })


# ---------------------------------------------------------------------------
# RFID card management
# ---------------------------------------------------------------------------

@app.route("/api/cards", methods=["GET"])
def api_list_cards():
    """
    Return two lists: students with cards and students without cards.
    """
    with_cards    = students_with_cards()
    without_cards = students_without_cards()
    return _ok({
        "with_cards"   : [s.to_dict() for s in with_cards],
        "without_cards": [s.to_dict() for s in without_cards],
    })


@app.route("/api/cards/check", methods=["POST"])
def api_check_card():
    """
    Phase 1 of card assignment: inspect the current state of a UID
    without modifying anything.

    Body (JSON):
        student_id  int  required
        uid         str  required  (the scanned UID)

    Returns a CardCheckResult describing whether the card is unassigned,
    already assigned to this student, or owned by another student. The UID
    comes from the teacher's own reader (Web Serial) and is only written
    after the browser calls /api/cards/confirm.
    """
    body       = request.get_json(silent=True) or {}
    student_id = body.get("student_id")
    uid        = body.get("uid", "").strip()

    if not student_id:
        return _err("student_id is required", 400)
    if not uid:
        return _err("uid is required", 400)

    result = check_uid_for_assignment(uid, student_id)
    http_status = 200

    if result.outcome in (
        CardCheckOutcome.STUDENT_NOT_FOUND,
        CardCheckOutcome.STUDENT_INACTIVE,
    ):
        http_status = 400

    return _ok(result.to_dict(), http_status)


@app.route("/api/cards/confirm", methods=["POST"])
def api_confirm_card():
    """
    Write the card assignment to the database.

    Called after the browser read a UID from the teacher's reader and the
    teacher reviewed the /api/cards/check result.

    Body (JSON):
        student_id  int  required
        uid         str  required  (the UID read by the browser)
    """
    body       = request.get_json(silent=True) or {}
    student_id = body.get("student_id")
    uid        = (body.get("uid") or "").strip()

    if not student_id:
        return _err("student_id is required", 400)
    if not uid:
        return _err("uid is required", 400)

    result = confirm_assignment(uid, student_id)

    if not result.success():
        return _err(result.message, 400)

    student = get_student(student_id)
    return _ok({
        "outcome"             : result.outcome.value,
        "uid"                 : result.uid,
        "student"             : student.to_dict() if student else None,
        "previous_owner_id"   : result.previous_owner_id,
        "previous_owner_name" : result.previous_owner_name,
        "message"             : result.message,
    })


@app.route("/api/cards/cancel", methods=["POST"])
def api_cancel_card():
    """Cancel the current card assignment workflow. No DB changes."""
    result = cancel_assignment()
    return _ok(result)


@app.route("/api/cards/unassign", methods=["POST"])
def api_unassign_card():
    """
    Remove the RFID card from a student (sets rfid_uid = NULL).

    Body (JSON):
        student_id  int  required
    """
    body       = request.get_json(silent=True) or {}
    student_id = body.get("student_id")

    if not student_id:
        return _err("student_id is required", 400)

    from rfid_service import unassign_card, AssignmentOutcome
    result = unassign_card(student_id)

    if result.outcome == AssignmentOutcome.STUDENT_NOT_FOUND:
        return _err(result.message, 404)
    if not result.success():
        return _err(result.message, 400)

    student = get_student(student_id)
    return _ok({
        "outcome": result.outcome.value,
        "student": student.to_dict() if student else None,
        "message": result.message,
    })


# ---------------------------------------------------------------------------
# Classes — full CRUD
# ---------------------------------------------------------------------------

@app.route("/api/classes", methods=["GET", "POST"])
def api_classes():
    """
    GET  — list all classes ordered by name.
    POST — create a class.  Body: {name (required), description (optional)}
    """
    if request.method == "GET":
        from database import get_connection
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT id, name, description FROM classes ORDER BY name")
            rows = cur.fetchall()
        finally:
            conn.close()
        return _ok({"classes": [dict(r) for r in rows]})

    # POST
    from database import get_connection
    import sqlite3 as _sqlite3
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return _err("name is required", 400)
    description = (body.get("description") or "").strip() or None

    conn = get_connection()
    try:
        with conn:
            conn.execute(
                "INSERT INTO classes (name, description) VALUES (?, ?)",
                (name, description)
            )
            new_id = conn.execute(
                "SELECT id FROM classes WHERE name = ?", (name,)
            ).fetchone()["id"]
    except _sqlite3.IntegrityError:
        conn.close()
        return _err(f"A class named '{name}' already exists.", 409)
    finally:
        conn.close()

    conn2 = get_connection()
    try:
        row = conn2.execute(
            "SELECT id, name, description FROM classes WHERE id = ?", (new_id,)
        ).fetchone()
        cls = dict(row)
    finally:
        conn2.close()

    return _ok({"class": cls, "message": f"Class '{name}' created."}, 201)


@app.route("/api/classes/<int:class_id>", methods=["GET"])
def api_get_class(class_id: int):
    """Return one class by id."""
    from database import get_connection
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name, description FROM classes WHERE id = ?", (class_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return _err(f"Class {class_id} not found.", 404)
    return _ok({"class": dict(row)})


@app.route("/api/classes/<int:class_id>", methods=["PATCH"])
def api_update_class(class_id: int):
    """
    Update a class.

    Body (JSON): any subset of name, description.
    """
    from database import get_connection
    import sqlite3 as _sqlite3
    body = request.get_json(silent=True) or {}

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM classes WHERE id = ?", (class_id,)
        ).fetchone()
        if row is None:
            return _err(f"Class {class_id} not found.", 404)

        updates = {}
        if "name" in body and body["name"] is not None:
            updates["name"] = body["name"].strip()
        if "description" in body:
            updates["description"] = (body["description"] or "").strip() or None

        if not updates:
            row2 = conn.execute(
                "SELECT id, name, description FROM classes WHERE id = ?", (class_id,)
            ).fetchone()
            return _ok({"class": dict(row2), "message": "No fields changed."})

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [class_id]
        try:
            with conn:
                conn.execute(
                    f"UPDATE classes SET {set_clause} WHERE id = ?", values
                )
        except _sqlite3.IntegrityError as exc:
            return _err(f"Update failed: {exc}", 409)

        row3 = conn.execute(
            "SELECT id, name, description FROM classes WHERE id = ?", (class_id,)
        ).fetchone()
    finally:
        conn.close()

    return _ok({"class": dict(row3), "message": f"Class {class_id} updated."})


@app.route("/api/classes/<int:class_id>", methods=["DELETE"])
def api_delete_class(class_id: int):
    """
    Delete a class.

    Refused if any students or attendance_sessions reference this class,
    because cascading those deletions would silently destroy data.
    """
    from database import get_connection
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name FROM classes WHERE id = ?", (class_id,)
        ).fetchone()
        if row is None:
            return _err(f"Class {class_id} not found.", 404)

        # Check for students in this class.
        student_count = conn.execute(
            "SELECT COUNT(*) FROM students WHERE class_id = ?", (class_id,)
        ).fetchone()[0]
        if student_count > 0:
            return _err(
                f"Cannot delete class '{row['name']}': "
                f"{student_count} student(s) are assigned to it. "
                f"Reassign or remove them first.",
                409
            )

        # Check for sessions referencing this class.
        session_count = conn.execute(
            "SELECT COUNT(*) FROM attendance_sessions WHERE class_id = ?",
            (class_id,)
        ).fetchone()[0]
        if session_count > 0:
            return _err(
                f"Cannot delete class '{row['name']}': "
                f"{session_count} attendance session(s) reference it. "
                f"Delete those sessions first.",
                409
            )

        with conn:
            conn.execute("DELETE FROM classes WHERE id = ?", (class_id,))
    finally:
        conn.close()

    return _ok({"message": f"Class '{row['name']}' (id={class_id}) deleted."})


# ---------------------------------------------------------------------------
# Subjects — full CRUD
# ---------------------------------------------------------------------------

@app.route("/api/subjects", methods=["GET", "POST"])
def api_subjects():
    """
    GET  — list all subjects ordered by name.
    POST — create a subject.  Body: {name (required), code (optional)}
    """
    if request.method == "GET":
        from database import get_connection
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT id, name, code FROM subjects ORDER BY name")
            rows = cur.fetchall()
        finally:
            conn.close()
        return _ok({"subjects": [dict(r) for r in rows]})

    # POST
    from database import get_connection
    import sqlite3 as _sqlite3
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return _err("name is required", 400)
    code = (body.get("code") or "").strip() or None

    conn = get_connection()
    try:
        with conn:
            conn.execute(
                "INSERT INTO subjects (name, code) VALUES (?, ?)", (name, code)
            )
            new_id = conn.execute(
                "SELECT id FROM subjects WHERE name = ?", (name,)
            ).fetchone()["id"]
    except _sqlite3.IntegrityError:
        conn.close()
        return _err(f"A subject named '{name}' already exists.", 409)
    finally:
        conn.close()

    conn2 = get_connection()
    try:
        row = conn2.execute(
            "SELECT id, name, code FROM subjects WHERE id = ?", (new_id,)
        ).fetchone()
        subj = dict(row)
    finally:
        conn2.close()

    return _ok({"subject": subj, "message": f"Subject '{name}' created."}, 201)


@app.route("/api/subjects/<int:subject_id>", methods=["GET"])
def api_get_subject(subject_id: int):
    """Return one subject by id."""
    from database import get_connection
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name, code FROM subjects WHERE id = ?", (subject_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return _err(f"Subject {subject_id} not found.", 404)
    return _ok({"subject": dict(row)})


@app.route("/api/subjects/<int:subject_id>", methods=["PATCH"])
def api_update_subject(subject_id: int):
    """
    Update a subject.

    Body (JSON): any subset of name, code.
    """
    from database import get_connection
    import sqlite3 as _sqlite3
    body = request.get_json(silent=True) or {}

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM subjects WHERE id = ?", (subject_id,)
        ).fetchone()
        if row is None:
            return _err(f"Subject {subject_id} not found.", 404)

        updates = {}
        if "name" in body and body["name"] is not None:
            updates["name"] = body["name"].strip()
        if "code" in body:
            updates["code"] = (body["code"] or "").strip() or None

        if not updates:
            row2 = conn.execute(
                "SELECT id, name, code FROM subjects WHERE id = ?", (subject_id,)
            ).fetchone()
            return _ok({"subject": dict(row2), "message": "No fields changed."})

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [subject_id]
        try:
            with conn:
                conn.execute(
                    f"UPDATE subjects SET {set_clause} WHERE id = ?", values
                )
        except _sqlite3.IntegrityError as exc:
            return _err(f"Update failed: {exc}", 409)

        row3 = conn.execute(
            "SELECT id, name, code FROM subjects WHERE id = ?", (subject_id,)
        ).fetchone()
    finally:
        conn.close()

    return _ok({"subject": dict(row3), "message": f"Subject {subject_id} updated."})


@app.route("/api/subjects/<int:subject_id>", methods=["DELETE"])
def api_delete_subject(subject_id: int):
    """
    Delete a subject.

    Refused if any attendance_sessions reference this subject.
    """
    from database import get_connection
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name FROM subjects WHERE id = ?", (subject_id,)
        ).fetchone()
        if row is None:
            return _err(f"Subject {subject_id} not found.", 404)

        session_count = conn.execute(
            "SELECT COUNT(*) FROM attendance_sessions WHERE subject_id = ?",
            (subject_id,)
        ).fetchone()[0]
        if session_count > 0:
            return _err(
                f"Cannot delete subject '{row['name']}': "
                f"{session_count} session(s) reference it.",
                409
            )

        with conn:
            conn.execute("DELETE FROM subjects WHERE id = ?", (subject_id,))
    finally:
        conn.close()

    return _ok({"message": f"Subject '{row['name']}' (id={subject_id}) deleted."})


# ---------------------------------------------------------------------------
# Teachers — full CRUD
# ---------------------------------------------------------------------------

@app.route("/api/teachers", methods=["GET", "POST"])
def api_teachers():
    """
    GET  — list all active teachers ordered by name.
    POST — create a teacher.  Body: {name (required), username (required)}
    """
    if request.method == "GET":
        from database import get_connection
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT id, name, username, status FROM teachers "
                "WHERE status = 'active' ORDER BY name"
            )
            rows = cur.fetchall()
        finally:
            conn.close()
        return _ok({"teachers": [dict(r) for r in rows]})

    # POST
    from database import get_connection
    import sqlite3 as _sqlite3
    body = request.get_json(silent=True) or {}
    name     = (body.get("name")     or "").strip()
    username = (body.get("username") or "").strip()

    if not name:
        return _err("name is required", 400)
    if not username:
        return _err("username is required", 400)

    conn = get_connection()
    try:
        ts = _now_iso()
        with conn:
            conn.execute(
                "INSERT INTO teachers (name, username, password_hash, status, created_at) "
                "VALUES (?, ?, NULL, 'active', ?)",
                (name, username, ts)
            )
            new_id = conn.execute(
                "SELECT id FROM teachers WHERE username = ?", (username,)
            ).fetchone()["id"]
    except _sqlite3.IntegrityError:
        conn.close()
        return _err(f"Username '{username}' is already taken.", 409)
    finally:
        conn.close()

    conn2 = get_connection()
    try:
        row = conn2.execute(
            "SELECT id, name, username, status, created_at FROM teachers WHERE id = ?",
            (new_id,)
        ).fetchone()
        teacher = dict(row)
    finally:
        conn2.close()

    return _ok({"teacher": teacher, "message": f"Teacher '{name}' created."}, 201)


@app.route("/api/teachers/<int:teacher_id>", methods=["GET"])
def api_get_teacher(teacher_id: int):
    """Return one teacher by id."""
    from database import get_connection
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name, username, status, created_at FROM teachers WHERE id = ?",
            (teacher_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return _err(f"Teacher {teacher_id} not found.", 404)
    return _ok({"teacher": dict(row)})


@app.route("/api/teachers/<int:teacher_id>", methods=["PATCH"])
def api_update_teacher(teacher_id: int):
    """
    Update a teacher.

    Body (JSON): any subset of name, username, status.
    password_hash is NOT updatable here (no authentication yet).
    """
    from database import get_connection
    import sqlite3 as _sqlite3
    body = request.get_json(silent=True) or {}

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM teachers WHERE id = ?", (teacher_id,)
        ).fetchone()
        if row is None:
            return _err(f"Teacher {teacher_id} not found.", 404)

        updates = {}
        if "name"     in body and body["name"]     is not None:
            updates["name"]     = body["name"].strip()
        if "username" in body and body["username"] is not None:
            updates["username"] = body["username"].strip()
        if "status"   in body and body["status"]   is not None:
            updates["status"]   = body["status"]

        if not updates:
            row2 = conn.execute(
                "SELECT id, name, username, status, created_at FROM teachers WHERE id = ?",
                (teacher_id,)
            ).fetchone()
            return _ok({"teacher": dict(row2), "message": "No fields changed."})

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [teacher_id]
        try:
            with conn:
                conn.execute(
                    f"UPDATE teachers SET {set_clause} WHERE id = ?", values
                )
        except _sqlite3.IntegrityError as exc:
            return _err(f"Update failed: {exc}", 409)

        row3 = conn.execute(
            "SELECT id, name, username, status, created_at FROM teachers WHERE id = ?",
            (teacher_id,)
        ).fetchone()
    finally:
        conn.close()

    return _ok({"teacher": dict(row3), "message": f"Teacher {teacher_id} updated."})


@app.route("/api/teachers/<int:teacher_id>", methods=["DELETE"])
def api_delete_teacher(teacher_id: int):
    """
    Delete a teacher.

    If the teacher is referenced by sessions, the sessions are not deleted —
    the teacher_id on those sessions is set to NULL instead, preserving the
    historical session records.  The teacher row is then deleted.

    This follows the prototype's existing design: teacher_id on sessions is
    nullable, so detaching is the safe option rather than blocking deletion
    or cascading.
    """
    from database import get_connection
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name FROM teachers WHERE id = ?", (teacher_id,)
        ).fetchone()
        if row is None:
            return _err(f"Teacher {teacher_id} not found.", 404)

        with conn:
            # Detach from sessions (teacher_id is nullable).
            conn.execute(
                "UPDATE attendance_sessions SET teacher_id = NULL WHERE teacher_id = ?",
                (teacher_id,)
            )
            conn.execute("DELETE FROM teachers WHERE id = ?", (teacher_id,))
    finally:
        conn.close()

    return _ok({"message": f"Teacher '{row['name']}' (id={teacher_id}) deleted."})


# ---------------------------------------------------------------------------
# Students — DELETE
# ---------------------------------------------------------------------------

@app.route("/api/students/<int:student_id>", methods=["DELETE"])
def api_delete_student(student_id: int):
    """
    Delete a student.

    Refused if the student has attendance records — deleting them would
    silently destroy historical data.  The caller must acknowledge this
    explicitly (no auto-cascade).
    """
    from database import get_connection
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, first_name, last_name FROM students WHERE id = ?",
            (student_id,)
        ).fetchone()
        if row is None:
            return _err(f"Student {student_id} not found.", 404)

        attendance_count = conn.execute(
            "SELECT COUNT(*) FROM attendance WHERE student_id = ?",
            (student_id,)
        ).fetchone()[0]
        if attendance_count > 0:
            return _err(
                f"Cannot delete student '{row['first_name']} {row['last_name']}': "
                f"{attendance_count} attendance record(s) exist. "
                f"Historical attendance cannot be automatically removed.",
                409
            )

        with conn:
            conn.execute("DELETE FROM students WHERE id = ?", (student_id,))
    finally:
        conn.close()

    return _ok({
        "message": (
            f"Student '{row['first_name']} {row['last_name']}' "
            f"(id={student_id}) deleted."
        )
    })


# ---------------------------------------------------------------------------
# Sessions — PATCH and DELETE
# ---------------------------------------------------------------------------

@app.route("/api/sessions/<int:session_id>", methods=["PATCH"])
def api_update_session(session_id: int):
    """
    Update editable session fields.

    Allowed fields: session_date, start_time, end_time, room, teacher_id,
    subject_id, slot_id.
    class_id may also be updated, but ONLY if the session is still SCHEDULED
    (no attendance can have been taken yet).

    Protected fields (status, opened_at, closed_at, completed_at) are never
    updated here — use the /open, /close, /complete endpoints instead.

    COMPLETED sessions cannot be edited.
    """
    from database import get_connection
    import sqlite3 as _sqlite3
    body = request.get_json(silent=True) or {}

    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, status FROM attendance_sessions WHERE id = ?",
            (session_id,)
        ).fetchone()
        if row is None:
            return _err(f"Session {session_id} not found.", 404)

        if row["status"] == "COMPLETED":
            return _err(
                f"Session {session_id} is COMPLETED and cannot be edited.",
                400
            )

        updates = {}

        if "session_date" in body and body["session_date"] is not None:
            updates["session_date"] = body["session_date"]
        if "start_time" in body:
            updates["start_time"] = body["start_time"] or None
        if "end_time" in body:
            updates["end_time"] = body["end_time"] or None
        if "room" in body:
            updates["room"] = body["room"] or None
        if "teacher_id" in body:
            updates["teacher_id"] = body["teacher_id"]
        if "subject_id" in body:
            updates["subject_id"] = body["subject_id"]
        if "slot_id" in body:
            updates["slot_id"] = body["slot_id"] or None

        # class_id only allowed when SCHEDULED (no attendance exists yet).
        if "class_id" in body:
            if row["status"] != "SCHEDULED":
                return _err(
                    "class_id can only be changed while the session is SCHEDULED.",
                    400
                )
            updates["class_id"] = body["class_id"]

        # Silently ignore any attempt to set protected timestamp/status fields.
        for protected in ("status", "opened_at", "closed_at", "completed_at",
                          "created_at"):
            updates.pop(protected, None)

        if not updates:
            from session_service import get_session
            session = get_session(session_id)
            return _ok({
                "session": session.to_dict(),
                "message": "No editable fields provided."
            })

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [session_id]
        try:
            with conn:
                conn.execute(
                    f"UPDATE attendance_sessions SET {set_clause} WHERE id = ?",
                    values
                )
        except _sqlite3.IntegrityError as exc:
            return _err(f"Update failed: {exc}", 400)

    finally:
        conn.close()

    from session_service import get_session
    session = get_session(session_id)
    return _ok({"session": session.to_dict(), "message": f"Session {session_id} updated."})


@app.route("/api/sessions/<int:session_id>", methods=["DELETE"])
def api_delete_session(session_id: int):
    """
    Delete a session.

    Rules:
      - COMPLETED sessions cannot be deleted (they are historical records).
      - Sessions with any attendance records cannot be deleted.
      - SCHEDULED, OPEN, or CLOSED sessions with no attendance can be deleted.
    """
    from database import get_connection
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, status, session_date FROM attendance_sessions WHERE id = ?",
            (session_id,)
        ).fetchone()
        if row is None:
            return _err(f"Session {session_id} not found.", 404)

        if row["status"] == "COMPLETED":
            return _err(
                f"Session {session_id} is COMPLETED and cannot be deleted. "
                f"Completed sessions are permanent historical records.",
                409
            )

        attendance_count = conn.execute(
            "SELECT COUNT(*) FROM attendance WHERE session_id = ?",
            (session_id,)
        ).fetchone()[0]
        if attendance_count > 0:
            return _err(
                f"Cannot delete session {session_id}: "
                f"{attendance_count} attendance record(s) exist. "
                f"Attendance records cannot be automatically removed.",
                409
            )

        with conn:
            conn.execute(
                "DELETE FROM attendance_sessions WHERE id = ?", (session_id,)
            )
    finally:
        conn.close()

    return _ok({
        "message": (
            f"Session {session_id} ({row['session_date']}) deleted."
        )
    })


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.route("/api/health", methods=["GET"])
def api_health():
    """Simple health check."""
    return _ok({
        "status" : "ok",
        "time"   : _now_iso(),
    })


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.errorhandler(404)
def not_found(e):
    return _err("Not found", 404)


@app.errorhandler(405)
def method_not_allowed(e):
    return _err("Method not allowed", 405)


@app.errorhandler(500)
def internal_error(e):
    return _err(f"Internal server error: {e}", 500)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    flask_host = os.environ.get("FLASK_HOST", "127.0.0.1")
    flask_port = int(os.environ.get("FLASK_PORT", "5000"))
    debug      = os.environ.get("FLASK_DEBUG", "0") == "1"

    # Initialise DB schema (safe to call repeatedly — IF NOT EXISTS).
    initialize_database()

    print(f"\nRFID Attendance Portal")
    print(f"  URL  : http://{flask_host}:{flask_port}")
    print(f"  RFID : opened by the browser (Web Serial) — no server device required")
    print(f"  Debug: {debug}\n")

    app.run(
        host=flask_host,
        port=flask_port,
        debug=debug,
        use_reloader=False,
    )
