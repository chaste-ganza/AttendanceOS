import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";

const initial = { state: "idle", result: null, busy: false };

export default function useAttendanceScanner({ session, students = [], records = [], onRecorded }) {
  const [state, setState] = useState(initial.state);
  const [result, setResult] = useState(initial.result);
  const [busy, setBusy] = useState(initial.busy);
  const lastScanRef = useRef(null);

  const reset = useCallback(() => {
    setState("idle");
    setResult(null);
  }, []);

  useEffect(() => {
    if (!session || session.status !== "open") {
      return undefined;
    }

    let active = true;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      setBusy(true);
      try {
        const scan = await api.reader.scanResult();
        if (!active || scan.outcome === "IDLE" || !scan.last_scan_at) return;
        const scanKey = `${scan.last_scan_at}:${scan.uid || ""}:${scan.outcome}`;
        if (lastScanRef.current === scanKey) return;
        lastScanRef.current = scanKey;
        if (scan.session_id != null && String(scan.session_id) !== String(session.id)) return;

        const student = students.find((item) => String(item.id) === String(scan.student_id)) || null;
        const time = scan.attendance_time || scan.last_scan_at;
        let record = records.find((item) =>
          String(item.session_id) === String(session.id) && String(item.student_id) === String(scan.student_id)
        ) || null;

        if (scan.outcome === "SUCCESS" || scan.outcome === "DUPLICATE") {
          const allRecords = await api.entities.Attendance.filter({ session_id: session.id });
          record = allRecords.find((item) => String(item.student_id) === String(scan.student_id)) || record;
          if (scan.outcome === "SUCCESS" && record) onRecorded?.(record);
        }

        if (!active) return;
        const nextState = {
          SUCCESS: "success",
          DUPLICATE: "duplicate",
          UNKNOWN_CARD: "unknown",
          WRONG_CLASS: "wrong-class",
          NO_OPEN_SESSION: "closed",
          ERROR: "error",
        }[scan.outcome] || "error";
        setState(nextState);
        setResult({
          uid: scan.uid,
          student,
          time: record?.recorded_at || time,
          record,
          message: scan.message,
        });
      } catch (requestError) {
        if (active) {
          setState("error");
          setResult({ message: requestError.message });
        }
      } finally {
        inFlight = false;
        if (active) setBusy(false);
      }
    };

    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session, students, records, onRecorded]);

  const sessionOpen = Boolean(session && session.status === "open");
  return {
    state: sessionOpen ? state : "idle",
    result: sessionOpen ? result : null,
    busy: sessionOpen && busy,
    reset,
  };
}
