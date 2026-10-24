"""Server-side teacher accounts and password reset token operations."""

import hashlib
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

from werkzeug.security import check_password_hash, generate_password_hash

from database import get_connection


def _now():
    return datetime.now(timezone.utc)


def _iso(value):
    return value.strftime("%Y-%m-%dT%H:%M:%S")


def public_teacher(row):
    return {
        "id": row["id"],
        "email": row["username"],
        "full_name": row["name"],
    }


def create_teacher(email: str, full_name: str, password: str):
    email = email.strip().lower()
    full_name = full_name.strip()
    if not email or "@" not in email:
        return None, "A valid email address is required.", 400
    if not full_name:
        return None, "Your name is required.", 400
    if len(password) < 8:
        return None, "Password must be at least 8 characters.", 400

    conn = get_connection()
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO teachers (name, username, password_hash, status, created_at) "
                "VALUES (?, ?, ?, 'active', ?)",
                (full_name, email, generate_password_hash(password), _iso(_now())),
            )
            row = conn.execute(
                "SELECT id, name, username FROM teachers WHERE id = ?", (cur.lastrowid,)
            ).fetchone()
        return public_teacher(row), "Account created.", 201
    except sqlite3.IntegrityError:
        return None, "An account with this email already exists.", 409
    finally:
        conn.close()


def authenticate_teacher(email: str, password: str):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name, username, password_hash, status "
            "FROM teachers WHERE username = ? COLLATE NOCASE",
            (email.strip(),),
        ).fetchone()
        if not row or row["status"] != "active" or not row["password_hash"]:
            return None
        if not check_password_hash(row["password_hash"], password):
            return None
        return public_teacher(row)
    finally:
        conn.close()


def get_teacher(teacher_id: int):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name, username FROM teachers WHERE id = ? AND status = 'active'",
            (teacher_id,),
        ).fetchone()
        return public_teacher(row) if row else None
    finally:
        conn.close()


def issue_reset_token(email: str):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = _now()
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, name, username FROM teachers "
            "WHERE username = ? COLLATE NOCASE AND status = 'active'",
            (email.strip(),),
        ).fetchone()
        if not row:
            return None
        with conn:
            conn.execute(
                "DELETE FROM password_reset_tokens WHERE teacher_id = ?", (row["id"],)
            )
            conn.execute(
                "INSERT INTO password_reset_tokens (teacher_id, token_hash, expires_at, created_at) "
                "VALUES (?, ?, ?, ?)",
                (row["id"], token_hash, _iso(now + timedelta(hours=1)), _iso(now)),
            )
        return {"teacher": public_teacher(row), "token": token}
    finally:
        conn.close()


def reset_teacher_password(token: str, new_password: str):
    if len(new_password) < 8:
        return False, "Password must be at least 8 characters.", 400
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id, teacher_id, expires_at FROM password_reset_tokens WHERE token_hash = ?",
            (token_hash,),
        ).fetchone()
        if not row:
            return False, "This password reset link is invalid or expired.", 400
        if datetime.fromisoformat(row["expires_at"]).replace(tzinfo=timezone.utc) < _now():
            with conn:
                conn.execute("DELETE FROM password_reset_tokens WHERE id = ?", (row["id"],))
            return False, "This password reset link is invalid or expired.", 400
        with conn:
            conn.execute(
                "UPDATE teachers SET password_hash = ? WHERE id = ?",
                (generate_password_hash(new_password), row["teacher_id"]),
            )
            conn.execute(
                "DELETE FROM password_reset_tokens WHERE teacher_id = ?", (row["teacher_id"],)
            )
        return True, "Password updated.", 200
    finally:
        conn.close()
