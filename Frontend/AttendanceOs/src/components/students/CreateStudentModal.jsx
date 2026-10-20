import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function CreateStudentModal({ open, onOpenChange, onCreated }) {
  const { data: classes = [], isPending: classesLoading, isError: classesError } = useQuery({
    queryKey: ["classes"],
    queryFn: () => api.classes.list(),
    enabled: open,
  });
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [studentCode, setStudentCode] = useState("");
  const [classId, setClassId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedClassId = classId || (classes.length ? String(classes[0].id) : "");

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await api.entities.Student.create({
        first_name: firstName,
        last_name: lastName,
        student_code: studentCode,
        class_id: Number(selectedClassId),
      });
      setFirstName("");
      setLastName("");
      setStudentCode("");
      onCreated?.();
      onOpenChange(false);
    } catch (requestError) {
      setError(requestError.message || "Student could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><UserPlus className="h-5 w-5" /></div>
          <DialogTitle className="font-heading text-xl font-bold">Add student</DialogTitle>
          <DialogDescription>This student will be saved to the attendance database. Assign their RFID card after enrollment.</DialogDescription>
        </DialogHeader>
        {error && <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive" role="alert">{error}</p>}
        {classesError && <p className="text-sm text-destructive" role="alert">Could not load classes. Close and reopen this form to retry.</p>}
        {!classesLoading && !classesError && classes.length === 0 && <p className="text-sm text-muted-foreground">Create a class in Settings before enrolling students.</p>}
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="student-first-name">First name</Label><Input id="student-first-name" autoComplete="given-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required /></div>
            <div className="space-y-2"><Label htmlFor="student-last-name">Last name</Label><Input id="student-last-name" autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} required /></div>
          </div>
          <div className="space-y-2"><Label htmlFor="student-code">Registration number</Label><Input id="student-code" value={studentCode} onChange={(event) => setStudentCode(event.target.value)} required /></div>
          <div className="space-y-2">
            <Label htmlFor="student-class">Class</Label>
            <select id="student-class" value={selectedClassId} onChange={(event) => setClassId(event.target.value)} disabled={classesLoading || classes.length === 0} className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm">
              {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || classesLoading || classes.length === 0}>{saving ? "Saving…" : "Create student"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
