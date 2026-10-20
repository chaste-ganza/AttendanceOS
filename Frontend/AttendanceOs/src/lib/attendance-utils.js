export const SESSION_STATUS = {
  scheduled: { label: "Scheduled", className: "bg-amber-500/10 text-amber-700 ring-amber-500/20", dot: "bg-amber-500" },
  open: { label: "Open", className: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20", dot: "bg-emerald-500" },
  closed: { label: "Closed", className: "bg-slate-500/10 text-slate-700 ring-slate-500/20", dot: "bg-slate-500" },
  completed: { label: "Completed", className: "bg-indigo-500/10 text-indigo-700 ring-indigo-500/20", dot: "bg-indigo-500" },
};

export const ATTENDANCE_STATUS = {
  present: { label: "Present", className: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20", dot: "bg-emerald-500" },
  late: { label: "Late", className: "bg-amber-500/10 text-amber-700 ring-amber-500/20", dot: "bg-amber-500" },
  absent: { label: "Absent", className: "bg-rose-500/10 text-rose-700 ring-rose-500/20", dot: "bg-rose-500" },
};

export const rosterOf = (students = []) => students.filter((student) => student.status !== "inactive");
export const initials = (name = "") => name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "?";
export const avatarTone = (name = "") => ["bg-indigo-500/10 text-indigo-700", "bg-emerald-500/10 text-emerald-700", "bg-amber-500/10 text-amber-700", "bg-rose-500/10 text-rose-700"][[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 4];
export const toISODate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatElapsed(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export const sessionAction = (status) => ({ scheduled: "Open session", open: "View live", closed: "Review", completed: "View" }[status] || "View");

export function sessionStats(session, students = [], records = []) {
  const total = rosterOf(students).length;
  const present = records.filter((record) => record.session_id === session.id && (record.status === "present" || record.status === "late")).length;
  return { total, present, absent: Math.max(0, total - present), rate: total ? Math.round((present / total) * 100) : 0 };
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function studentHistory(student, sessions = [], attendance = []) {
  const held = sessions.filter((session) => session.status !== "scheduled");
  const entries = held.map((session) => {
    const record = attendance.find((item) => item.session_id === session.id && item.student_id === student.id) || null;
    return { session, record, status: record?.status || "absent" };
  }).sort((a, b) => b.session.date.localeCompare(a.session.date));
  const attended = entries.filter((entry) => entry.record).length;
  const late = entries.filter((entry) => entry.status === "late").length;
  return { entries, attended, late, total: held.length, absent: Math.max(0, held.length - attended), rate: held.length ? Math.round((attended / held.length) * 100) : 0 };
}

export function studentHistoryCsv(student, history) {
  return [["Session", "Date", "Start time", "Recorded at", "Status"], ...history.entries.map(({ session, record, status }) => [session.subject, session.date, session.start_time, record?.recorded_at || "", status])];
}
