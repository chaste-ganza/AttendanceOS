import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Radio, Timer, Usb, WifiOff, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useReader } from "@/lib/reader-context";
import useAttendanceScanner from "@/hooks/useAttendanceScanner";
import ScanVisual from "@/components/rfid/ScanVisual";
import ScanResult from "@/components/rfid/ScanResult";
import { formatElapsed } from "@/lib/attendance-utils";

export default function RfidScanner({ session, onOpenSession }) {
  const navigate = useNavigate();
  const {
    supported,
    connected,
    connecting,
    portLabel,
    error: readerError,
    connect,
    disconnect,
    lastScan,
  } = useReader();
  const [, refreshElapsed] = useState(0);
  const scanner = useAttendanceScanner({ session, lastScan });

  const locked = !session || session.status !== "open";
  const lockedState = locked ? (session?.status === "scheduled" ? "scheduled" : "closed") : null;
  const view = scanner.state === "idle" ? (lockedState || (!connected ? "offline" : "idle")) : scanner.state;

  useEffect(() => {
    const id = setInterval(() => refreshElapsed((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (scanner.state === "success" && scanner.result?.student) {
      toast.success("Attendance recorded", {
        description: `${scanner.result.student.full_name} · ${scanner.result.student.student_code}`,
      });
    }
    if (scanner.state === "duplicate" && scanner.result?.student) {
      toast.warning("Already marked present", {
        description: `${scanner.result.student.full_name} was already recorded for this session.`,
      });
    }
    if (scanner.state === "unknown") {
      toast.error("Unregistered RFID card", {
        description: `UID ${scanner.result?.uid} is not assigned to a student.`,
      });
    }
    if (scanner.state === "error" && scanner.result?.message) {
      toast.error("Could not record the scan", { description: scanner.result.message });
    }
  }, [scanner.state, scanner.result]);

  const statusLine = connected
    ? `Connected${portLabel ? ` · ${portLabel}` : ""}`
    : connecting
      ? "Connecting to the reader…"
      : supported
        ? "Not connected — plug in your own USB reader"
        : "USB readers need Chrome or Edge on desktop";

  return (
    <section className="surface overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl",
              connected
                ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300"
                : "bg-rose-500/12 text-rose-600 dark:text-rose-300"
            )}
          >
            {connected ? <Radio className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
          </div>
          <div>
            <p className="font-heading text-sm font-bold tracking-tight">RFID reader</p>
            <p
              className={cn(
                "text-xs font-medium",
                connected ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"
              )}
            >
              {statusLine}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {session && (
            <span className="rounded-full border border-border/70 bg-muted/60 px-3 py-1.5 text-xs font-semibold">
              {session.subject}
            </span>
          )}
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-xs font-semibold",
              session?.status === "open"
                ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-border/70 bg-muted/60 text-muted-foreground"
            )}
          >
            <Timer className="h-3.5 w-3.5" />
            {session?.status === "open" && session?.opened_at ? formatElapsed(session.opened_at) : "—"}
          </span>
        </div>
      </header>

      <div className="grid gap-5 p-5 lg:grid-cols-2">
        <ScanVisual state={view} isOnline={connected} />
        <ScanResult
          view={view}
          result={scanner.result}
          onManageCard={() => navigate("/rfid-cards")}
          onOpenSession={onOpenSession}
          onReconnect={supported ? connect : undefined}
          unsupported={!supported}
        />
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-border/70 bg-muted/40 px-5 py-4">
        {connected ? (
          <Button variant="outline" onClick={disconnect}>
            <Usb className="mr-2 h-4 w-4" />
            Disconnect reader
          </Button>
        ) : (
          <Button onClick={connect} disabled={!supported || connecting}>
            <Usb className="mr-2 h-4 w-4" />
            {connecting ? "Connecting…" : "Connect reader"}
          </Button>
        )}

        {readerError && (
          <p className="text-xs font-medium text-destructive" role="status">
            {readerError}
          </p>
        )}

        <p className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <ScanLine className="h-3.5 w-3.5" />
          {locked
            ? "Scanner disabled while the session is not open"
            : connected
              ? "Tap a card on your reader; results appear here."
              : "Connect your USB reader to begin scanning."}
        </p>
      </footer>
    </section>
  );
}
