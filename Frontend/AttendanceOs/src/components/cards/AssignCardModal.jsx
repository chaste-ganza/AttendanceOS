import React, { useState } from "react";
import { toast } from "sonner";
import { CreditCard } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StepConfirm, StepConflict, StepScan, StepSelect } from "@/components/cards/AssignCardSteps";
import { api } from "@/api/client";

export default function AssignCardModal({ open, onOpenChange, students, initialStudentId, onAssigned }) {
  const key = `${open}:${initialStudentId || ""}`;
  return (
    <AssignCardDialog
      key={key}
      open={open}
      onOpenChange={onOpenChange}
      students={students}
      initialStudentId={initialStudentId}
      onAssigned={onAssigned}
    />
  );
}

function AssignCardDialog({ open, onOpenChange, students, initialStudentId, onAssigned }) {
  const [step, setStep] = useState(initialStudentId ? "scan" : "select");
  const [selectedId, setSelectedId] = useState(initialStudentId || null);
  const [uid, setUid] = useState("");
  const [owner, setOwner] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  const student = students.find((item) => item.id === selectedId) || null;

  const runScan = async () => {
    if (scanning || !student) return;
    setScanning(true);
    setUid("");
    setStep("scan");
    try {
      const response = await api.cards.assign(student.id, 30);
      const check = response.check;
      if (response.outcome !== "CARD_SCANNED" || !check) {
        throw new Error(response.message || "The reader did not return a card UID.");
      }
      const candidate = response.uid;
      setUid(candidate);
      if (check.outcome === "OWNED_BY_OTHER") {
        const ownerId = String(check.current_owner_id);
        setOwner(students.find((item) => String(item.id) === ownerId) || {
          id: ownerId,
          full_name: check.current_owner_name,
          student_code: check.current_owner_reg,
          rfid_uid: candidate,
        });
        setStep("conflict");
      } else if (["UNASSIGNED", "ALREADY_ASSIGNED_SELF"].includes(check.outcome)) {
        setOwner(null);
        setStep("scan");
      } else {
        throw new Error(check.message || "This student or card cannot be assigned.");
      }
    } catch (error) {
      toast.error(error.message || "The reader could not scan a card.");
    } finally {
      setScanning(false);
    }
  };

  const finish = async () => {
    if (!student || !uid) return;
    setSaving(true);
    try {
      await api.cards.confirm(student.id, uid);
      toast.success(owner ? "RFID card reassigned" : "RFID card successfully assigned.", {
        description: `${uid} → ${student.full_name}`,
      });
      onAssigned?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(error.message || "The card could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const titles = {
    select: "Select Student",
    scan: "Place RFID card on reader",
    conflict: "Card Already Assigned",
    confirm: "Confirm RFID reassignment",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <CreditCard className="h-5 w-5" />
          </div>
          <DialogTitle className="font-heading text-xl font-bold tracking-tight">{titles[step]}</DialogTitle>
          <DialogDescription>
            {step === "select"
              ? "Choose the student this card should belong to."
              : step === "scan"
              ? "The UID is read directly from the card on READER-01."
              : "A card can only belong to one student at a time."}
          </DialogDescription>
        </DialogHeader>

        {step === "select" && (
          <StepSelect
            students={students}
            query={query}
            onQuery={setQuery}
            onPick={(picked) => {
              setSelectedId(picked.id);
              setStep("scan");
            }}
          />
        )}

        {step === "scan" && student && (
          <StepScan
            student={student}
            scanning={scanning}
            uid={uid}
            onScan={() => runScan()}
            onConfirm={owner ? () => setStep("confirm") : finish}
            onRescan={() => runScan("fresh")}
            onBack={() => {
              setUid("");
              setOwner(null);
              setStep("select");
            }}
          />
        )}

        {step === "conflict" && student && owner && (
          <StepConflict
            student={student}
            owner={owner}
            uid={uid}
            onCancel={() => onOpenChange(false)}
            onUpdateOwner={() => setStep("confirm")}
          />
        )}

        {step === "confirm" && student && owner && (
          <StepConfirm
            student={student}
            owner={owner}
            uid={uid}
            saving={saving}
            onCancel={() => onOpenChange(false)}
            onConfirm={finish}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
