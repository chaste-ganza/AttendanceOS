const apiError = (message, status, payload) => Object.assign(new Error(message), { status, payload });
let signedInUser = null;

async function request(path, { method = "GET", body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw apiError("Could not reach the AttendanceOS API. Check the server connection and try again.", 0);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw apiError(payload.error || payload.message || `Request failed (${response.status}).`, response.status, payload);
  }
  return payload;
}

const withQuery = (path, values = {}) => {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, value);
  });
  const query = params.toString();
  return query ? `${path}?${query}` : path;
};

const sortRows = (rows, sort) => {
  if (!sort) return rows;
  const desc = sort.startsWith("-");
  const key = desc ? sort.slice(1) : sort;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === y) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const compare = typeof x === "number" && typeof y === "number"
      ? x - y
      : String(x).localeCompare(String(y));
    return desc ? -compare : compare;
  });
};

const normalizeStudent = (student) => ({
  ...student,
  id: String(student.id),
  student_code: student.registration_number,
  full_name: student.full_name || `${student.first_name || ""} ${student.last_name || ""}`.trim(),
  rfid_uid: student.rfid_uid || "",
});

const normalizeSession = (session) => ({
  ...session,
  id: String(session.id),
  date: session.session_date,
  subject: session.subject_name || "Untitled session",
  status: String(session.status || "SCHEDULED").toLowerCase(),
  opened_at: session.opened_at,
  slot_id: session.slot_id == null ? "" : String(session.slot_id),
});

const normalizeAttendance = (record) => ({
  ...record,
  id: String(record.id),
  session_id: String(record.session_id),
  student_id: String(record.student_id),
  recorded_at: record.attendance_time,
  method: "rfid",
});

const normalizeSlot = (slot) => ({ ...slot, id: String(slot.id) });

async function loadList(path, key, normalize, sort, limit) {
  const payload = await request(path);
  let rows = (payload[key] || []).map(normalize);
  rows = sortRows(rows, sort);
  return limit ? rows.slice(0, limit) : rows;
}

async function getClasses() {
  const { classes = [] } = await request("/api/classes");
  return classes;
}

async function getSubjects() {
  const { subjects = [] } = await request("/api/subjects");
  return subjects;
}

async function subjectIdFor(data) {
  if (data.subject_id) return Number(data.subject_id);
  const name = (data.subject || data.subject_name || "").trim();
  if (!name) throw apiError("A subject is required.", 400);
  const subjects = await getSubjects();
  const existing = subjects.find((subject) => subject.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const created = await request("/api/subjects", { method: "POST", body: { name } });
  return created.subject.id;
}

async function classIdFor(data) {
  if (data.class_id) return Number(data.class_id);
  const name = (data.class_name || "").trim();
  const classes = await getClasses();
  const existing = classes.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!existing) throw apiError(name ? `Class “${name}” is not in the database. Create the class first.` : "Choose a class.", 400);
  return existing.id;
}

async function sessionPayload(data) {
  const payload = {};
  if (data.class_id !== undefined || data.class_name !== undefined) payload.class_id = await classIdFor(data);
  if (data.subject_id !== undefined || data.subject !== undefined || data.subject_name !== undefined) {
    payload.subject_id = await subjectIdFor(data);
  }
  const teacher = api.auth.currentUser();
  payload.teacher_id = data.teacher_id || teacher?.id || null;
  for (const [from, to] of [
    ["date", "session_date"], ["session_date", "session_date"],
    ["start_time", "start_time"], ["end_time", "end_time"],
    ["room", "room"], ["slot_id", "slot_id"],
  ]) {
    if (data[from] !== undefined) payload[to] = data[from] === "" ? null : data[from];
  }
  return payload;
}

function entity(name) {
  const config = {
    Student: { path: "/api/students", key: "students", normalize: normalizeStudent },
    Session: { path: "/api/sessions", key: "sessions", normalize: normalizeSession },
    Attendance: { path: "/api/attendance", key: "attendance", normalize: normalizeAttendance },
    TimetableSlot: { path: "/api/timetable-slots", key: "slots", normalize: normalizeSlot },
  }[name];

  return {
    async list(sort, limit) {
      return loadList(config.path, config.key, config.normalize, sort, limit);
    },
    async filter(query = {}, sort, limit) {
      const params = {};
      if (name === "Student") {
        params.class_id = query.class_id;
        params.status = query.status;
        if (query.rfid_uid !== undefined) params.has_card = Boolean(query.rfid_uid);
      } else if (name === "Session") {
        params.class_id = query.class_id;
        params.status = query.status ? query.status.toUpperCase() : undefined;
        params.date = query.date;
      } else if (name === "Attendance") {
        params.session_id = query.session_id;
        params.student_id = query.student_id;
      }
      const payload = await request(withQuery(config.path, params));
      let rows = (payload[config.key] || []).map(config.normalize);
      rows = rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
      rows = sortRows(rows, sort);
      return limit ? rows.slice(0, limit) : rows;
    },
    async create(data) {
      if (name === "Attendance") {
        throw apiError("Attendance is recorded by the connected RFID reader.", 405);
      }
      let path = config.path;
      let body = data;
      if (name === "Student") {
        const names = data.full_name ? data.full_name.trim().split(/\s+/) : [];
        const firstName = data.first_name || names.shift() || "";
        const lastName = data.last_name || names.join(" ");
        body = {
          first_name: firstName,
          last_name: lastName,
          registration_number: data.registration_number || data.student_code,
          class_id: data.class_id || null,
          rfid_uid: data.rfid_uid || null,
        };
      } else if (name === "Session") {
        body = await sessionPayload(data);
      } else if (name === "TimetableSlot") {
        const classes = await getClasses();
        const classRow = classes.find((item) => item.name.toLowerCase() === (data.class_name || "").toLowerCase());
        if (!classRow) throw apiError("Choose an existing class before saving this timetable slot.", 400);
        body = {
          ...data,
          class_id: data.class_id || classRow.id,
          subject_id: await subjectIdFor(data),
          teacher_id: data.teacher_id || api.auth.currentUser()?.id || null,
        };
      }
      const payload = await request(path, { method: "POST", body });
      const item = payload[name === "Student" ? "student" : name === "Session" ? "session" : "slot"];
      return config.normalize(item);
    },
    async bulkCreate(items) {
      return Promise.all(items.map((item) => this.create(item)));
    },
    async update(id, data) {
      if (name === "Attendance") throw apiError("Attendance records cannot be edited from the dashboard.", 405);
      let body = data;
      let path = `${config.path}/${id}`;
      if (name === "Student") {
        if (Object.hasOwn(data, "rfid_uid")) {
          if (data.rfid_uid) throw apiError("Use the card assignment workflow to assign an RFID card.", 405);
          const { student } = await request("/api/cards/unassign", { method: "POST", body: { student_id: Number(id) } });
          return normalizeStudent(student);
        }
        body = { ...data };
        if (data.student_code !== undefined) body.registration_number = data.student_code;
        delete body.student_code;
        delete body.full_name;
      } else if (name === "Session") {
        body = await sessionPayload(data);
      } else if (name === "TimetableSlot") {
        if (data.subject !== undefined && data.subject_id === undefined) body = { ...data, subject_id: await subjectIdFor(data) };
      }
      const payload = await request(path, { method: "PATCH", body });
      return config.normalize(payload[name === "Student" ? "student" : name === "Session" ? "session" : "slot"]);
    },
    async delete(id) {
      if (name === "Attendance") throw apiError("Attendance records are historical and cannot be deleted here.", 405);
      const payload = await request(`${config.path}/${id}`, { method: "DELETE" });
      return { id, ...payload };
    },
  };
}

export const api = {
  entities: {
    Student: entity("Student"),
    Session: entity("Session"),
    Attendance: entity("Attendance"),
    TimetableSlot: entity("TimetableSlot"),
  },

  auth: {
    currentUser: () => signedInUser,
    async me() {
      try {
        const payload = await request("/api/auth/me");
        signedInUser = payload.user;
        return signedInUser;
      } catch (error) {
        if (error.status === 401) signedInUser = null;
        throw error;
      }
    },
    async register({ email, password, full_name }) {
      const payload = await request("/api/auth/register", {
        method: "POST", body: { email, password, full_name },
      });
      signedInUser = payload.user;
      return payload.user;
    },
    async loginViaEmailPassword(email, password) {
      const payload = await request("/api/auth/login", {
        method: "POST", body: { email, password },
      });
      signedInUser = payload.user;
      return signedInUser;
    },
    async logout() {
      await request("/api/auth/logout", { method: "POST" });
      signedInUser = null;
    },
    async resetPasswordRequest(email) {
      return request("/api/auth/password-reset", { method: "POST", body: { email } });
    },
    async resetPassword({ resetToken, newPassword }) {
      return request("/api/auth/password-reset/complete", {
        method: "POST", body: { reset_token: resetToken, new_password: newPassword },
      });
    },
  },

  classes: {
    async list() { return (await request("/api/classes")).classes || []; },
    async create(data) { return (await request("/api/classes", { method: "POST", body: data })).class; },
    async update(id, data) { return (await request(`/api/classes/${id}`, { method: "PATCH", body: data })).class; },
    async delete(id) { return request(`/api/classes/${id}`, { method: "DELETE" }); },
  },

  cards: {
    async list() {
      const payload = await request("/api/cards");
      return {
        with_cards: (payload.with_cards || []).map(normalizeStudent),
        without_cards: (payload.without_cards || []).map(normalizeStudent),
      };
    },
    async assign(student_id, timeout = 30) {
      return request("/api/cards/assign", { method: "POST", body: { student_id: Number(student_id), timeout } });
    },
    async check(student_id, uid) {
      return request("/api/cards/check", { method: "POST", body: { student_id: Number(student_id), uid } });
    },
    async confirm(student_id, uid) {
      const payload = await request("/api/cards/confirm", { method: "POST", body: { student_id: Number(student_id), uid } });
      return { ...payload, student: payload.student ? normalizeStudent(payload.student) : null };
    },
    async cancel() { return request("/api/cards/cancel", { method: "POST", body: {} }); },
    async unassign(student_id) {
      const payload = await request("/api/cards/unassign", { method: "POST", body: { student_id: Number(student_id) } });
      return { ...payload, student: payload.student ? normalizeStudent(payload.student) : null };
    },
  },

  reader: {
    async status() { return (await request("/api/health")).reader; },
    async scanResult() { return request("/api/scan-result?clear=1"); },
  },

  request,
};
