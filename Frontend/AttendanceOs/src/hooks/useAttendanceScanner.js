import { useCallback, useMemo, useState } from "react";

const OUTCOME_STATE = {
  SUCCESS: "success",
  DUPLICATE: "duplicate",
  UNKNOWN_CARD: "unknown",
  WRONG_CLASS: "wrong-class",
  NO_OPEN_SESSION: "closed",
  ERROR: "error",
};

const IDLE = { state: "idle", result: null };

/**
 * Turns the reader provider's latest scan into the visual state used by the
 * session page. Scans arrive from the browser's own serial connection, so
 * there is nothing to poll: each scan is recorded once by the provider and
 * surfaced here from `lastScan`, which is why the state is derived instead of
 * copied into an effect.
 */
export default function useAttendanceScanner({ session, lastScan }) {
  const [dismissedId, setDismissedId] = useState(null);

  const scanView = useMemo(() => {
    if (!lastScan || lastScan.id === dismissedId) return null;

    if (lastScan.error) {
      return { state: "error", result: { uid: lastScan.uid, message: lastScan.error } };
    }

    const scan = lastScan.result;
    if (!scan) return null;

    // The provider records taps from wherever the teacher is; only show
    // results that belong to the session on screen.
    if (scan.session_id != null && String(scan.session_id) !== String(session?.id)) return null;
    if (scan.outcome === "NO_OPEN_SESSION" && session?.status === "open") return null;

    return {
      state: OUTCOME_STATE[scan.outcome] ?? "error",
      result: {
        uid: scan.uid,
        student_id: scan.student_id,
        student: scan.student_id
          ? {
              id: String(scan.student_id),
              full_name: scan.full_name || "",
              student_code: scan.registration_number || "",
            }
          : null,
        time: scan.attendance_time,
        message: scan.message,
        session_id: scan.session_id,
      },
    };
  }, [lastScan, dismissedId, session]);

  const reset = useCallback(() => {
    setDismissedId(lastScan?.id ?? null);
  }, [lastScan]);

  return {
    state: scanView?.state ?? IDLE.state,
    result: scanView?.result ?? IDLE.result,
    reset,
  };
}
