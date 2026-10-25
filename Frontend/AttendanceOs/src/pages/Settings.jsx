import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "@/components/theme-provider";
import { toast } from "sonner";
import { CreditCard, Moon, Radio, Sparkles, Sun, User, Users, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/api/client";
import useCurrentUser from "@/lib/use-current-user";
import { useReader } from "@/lib/reader-context";
import { initials, rosterOf } from "@/lib/attendance-utils";
import { cn } from "@/lib/utils";
import { loadClassroom } from "@/lib/classroom";

function Panel({ icon: Icon, title, description, children }) {
  return (
    <section className="surface p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="font-heading text-base font-bold tracking-tight">{title}</p>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function Settings() {
  const user = useCurrentUser();
  const { supported, connected, connecting, portLabel, error: readerError, connect, disconnect } = useReader();
  const { setTheme, theme } = useTheme();
  const { data, isPending, isError, error, refetch } = useQuery({ queryKey: ["classroom"], queryFn: loadClassroom });
  const queryClient = useQueryClient();
  const { data: classes = [], isError: classesError, refetch: refetchClasses } = useQuery({ queryKey: ["classes"], queryFn: () => api.classes.list() });
  const [className, setClassName] = useState("");
  const [classError, setClassError] = useState("");
  const [classSaving, setClassSaving] = useState(false);
  const roster = rosterOf(data?.students || []);
  const withCard = roster.filter((student) => student.rfid_uid).length;

  const createClass = async (event) => {
    event.preventDefault();
    setClassError("");
    setClassSaving(true);
    try {
      await api.classes.create({ name: className });
      setClassName("");
      await queryClient.invalidateQueries({ queryKey: ["classes"] });
      toast.success("Class created");
    } catch (requestError) {
      setClassError(requestError.message);
    } finally {
      setClassSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-heading text-2xl font-extrabold tracking-tight">Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">Reader, profile and appearance preferences.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel icon={User} title="Teacher Profile" description="The account used for this portal.">
          <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/40 p-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-bold text-white">
              {initials(user?.full_name || "Teacher")}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{user?.full_name || "Teacher"}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email || "—"}</p>
            </div>
          </div>
        </Panel>

        <Panel
          icon={Radio}
          title="RFID Reader"
          description="Opened by this browser over USB — the reader stays on your own computer."
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
              <div>
                <p className="text-sm font-semibold">
                  {connected
                    ? "🟢 Reader connected"
                    : supported
                      ? "🔴 Reader not connected"
                      : "⚠️ Web Serial unavailable"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {connected
                    ? portLabel || "USB device"
                    : supported
                      ? "Plug in your own RFID reader and connect it."
                      : "Use Chrome or Edge on a desktop computer."}
                </p>
              </div>
              {connected ? <WifiOff className="h-5 w-5 text-rose-500" /> : <Radio className="h-5 w-5 text-rose-500" />}
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={connected ? disconnect : connect}
              disabled={!supported || connecting}
            >
              {connected ? "Disconnect reader" : connecting ? "Connecting…" : "Connect reader"}
            </Button>
            {readerError && <p className="text-sm text-destructive" role="status">{readerError}</p>}
          </div>
        </Panel>

        <Panel icon={Sun} title="Appearance" description="Switch between light and dark mode.">
          <div className="flex gap-2">
            <Button
              variant={theme === "light" ? "default" : "outline"}
              className="flex-1"
              onClick={() => {
                setTheme("light");
                toast.success("Light mode enabled");
              }}
            >
              <Sun className="mr-2 h-4 w-4" />
              Light
            </Button>
            <Button
              variant={theme === "dark" ? "default" : "outline"}
              className="flex-1"
              onClick={() => {
                setTheme("dark");
                toast.success("Dark mode enabled");
              }}
            >
              <Moon className="mr-2 h-4 w-4" />
              Dark
            </Button>
          </div>
        </Panel>

        <Panel icon={CreditCard} title="Class Roster" description="Cards currently linked to students.">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border/70 bg-muted/40 p-4">
              <Users className="h-4 w-4 text-muted-foreground" />
              <p className="mt-2 font-heading text-2xl font-extrabold">{isPending ? "—" : roster.length}</p>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Students</p>
            </div>
            <div className="rounded-xl border border-border/70 bg-muted/40 p-4">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              <p className="mt-2 font-heading text-2xl font-extrabold">{isPending ? "—" : withCard}</p>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Active cards</p>
            </div>
          </div>
        </Panel>
      </div>

      <Panel icon={Users} title="Classes" description="Classes are stored in the server database and used when scheduling sessions and enrolling students.">
        <form onSubmit={createClass} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1 space-y-2">
            <Label htmlFor="class-name">New class name</Label>
            <Input id="class-name" value={className} onChange={(event) => setClassName(event.target.value)} placeholder="e.g. Year 1A" required />
          </div>
          <Button type="submit" disabled={classSaving}>{classSaving ? "Saving…" : "Add class"}</Button>
        </form>
        {classError && <p className="mt-3 text-sm text-destructive" role="alert">{classError}</p>}
        {classesError ? (
          <div className="mt-3 flex items-center gap-3 text-sm text-destructive" role="alert">
            <span>Could not load classes.</span><Button type="button" variant="outline" size="sm" onClick={() => refetchClasses()}>Retry</Button>
          </div>
        ) : classes.length > 0 ? (
          <ul className="mt-4 flex flex-wrap gap-2">
            {classes.map((item) => <li key={item.id} className="rounded-full border border-border/70 bg-muted/50 px-3 py-1 text-xs font-medium">{item.name}</li>)}
          </ul>
        ) : <p className="mt-3 text-sm text-muted-foreground">No classes have been created yet.</p>}
      </Panel>

      {isError && (
        <div className="surface flex flex-wrap items-center justify-between gap-3 p-4" role="alert">
          <p className="text-sm text-destructive">Could not load roster counts: {error.message}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </div>
      )}

      <Panel
        icon={Sparkles}
        title="Connected data"
        description="Roster, sessions, and attendance are loaded from the Flask API and stored in SQLite."
      >
        <div className={cn("rounded-xl border border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground")}>
          Attendance is recorded when a physical card is read by the configured USB RFID reader. Card assignment also waits for a physical card scan.
        </div>
      </Panel>
    </div>
  );
}
