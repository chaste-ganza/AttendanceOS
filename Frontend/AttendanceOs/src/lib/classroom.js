import { api } from "@/api/client";

export async function loadClassroom() {
  const [students, sessions, attendance] = await Promise.all([
    api.entities.Student.list("student_code", 500),
    api.entities.Session.list("-date", 500),
    api.entities.Attendance.list("-recorded_at", 2000),
  ]);
  return { students, sessions, attendance };
}

export async function openSessionRecord(session) {
  const payload = await api.request(`/api/sessions/${session.id}/open`, { method: "POST", body: {} });
  return payload.session;
}

export async function closeSessionRecord(session) {
  const payload = await api.request(`/api/sessions/${session.id}/close`, { method: "POST", body: {} });
  return payload.session;
}
