// Simulates a serial port so the browser reader client can be exercised
// without Chrome or an Arduino. Run: node scripts/rfid-reader-sim.mjs
import { RfidReader, parseReaderLine, ReaderMode } from "../src/lib/rfid-reader.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makePort() {
  const commands = [];
  const queue = [];
  let controller;
  let closed = false;

  const readable = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });

  const writable = new WritableStream({
    write(chunk) {
      commands.push(decoder.decode(chunk));
    },
  });

  return {
    commands,
    readable,
    writable,
    getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    async open() {},
    async close() {
      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    emit(line) {
      controller.enqueue(encoder.encode(`${line}\n`));
    },
  };
}

const results = [];
const check = (label, condition, detail = "") => {
  results.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

const cards = [];
const errors = [];
let disconnects = 0;

const port = makePort();
const reader = new RfidReader({
  onCard: (uid) => cards.push(uid),
  onError: (message) => errors.push(message),
  onDisconnect: () => {
    disconnects += 1;
  },
});

await reader.open(port);
check("opening the port sends ON", port.commands[0] === "ON\n", JSON.stringify(port.commands));
check("reader reports connected", reader.isConnected);

check(
  "parser: UID line in normal mode",
  parseReaderLine("UID: a9 6e 95 04", ReaderMode.NORMAL).uid === "A96E9504"
);
check(
  "parser: UID line in assign mode",
  parseReaderLine("UID: AB529E04", ReaderMode.ASSIGN).kind === "assign-card"
);

port.emit("SYSTEM: ON");
port.emit("RFID reader: ACTIVE");
port.emit("UID: a9 6e 95 04");
await new Promise((r) => setTimeout(r, 20));
check("card tap reaches onCard with normalized UID", cards[0] === "A96E9504", cards.join(","));

const assignPromise = reader.requestAssignScan(2000);
await new Promise((r) => setTimeout(r, 20));
check("assign mode sends ASSIGN", port.commands.includes("ASSIGN\n"), port.commands.join("|"));
port.emit("ASSIGN: WAITING");
port.emit("UID: AB529E04");
port.emit("ASSIGN: DONE");
const assigned = await assignPromise;
check("assign scan resolves with the tapped card", assigned === "AB529E04", String(assigned));
check("assign scan does not record attendance", cards.length === 1, cards.join(","));

port.emit("UID: CAFEBABE");
await new Promise((r) => setTimeout(r, 20));
check("next tap returns to attendance scanning", cards[1] === "CAFEBABE", cards.join(","));

const timedOut = await reader.requestAssignScan(120).then(
  () => false,
  (error) => /No card/.test(error.message)
);
check("assign scan times out cleanly", timedOut);

port.emit("ERROR: Unknown command: X");
await new Promise((r) => setTimeout(r, 20));
check("firmware errors surface to the UI", errors.length === 1, errors.join("|"));

await reader.disconnect();
check("disconnect sends OFF", port.commands.includes("OFF\n"), port.commands.join("|"));
check("disconnect clears the connection", !reader.isConnected);

// A stream failure (cable pulled) must notify the provider.
const second = makePort();
const failing = new RfidReader({ onCard: () => {}, onDisconnect: () => (disconnects += 1) });
await failing.open(second);
second.emit("UID: 11223344");
await new Promise((r) => setTimeout(r, 20));
await second.close();
await new Promise((r) => setTimeout(r, 60));
check("unplugging reports a disconnect", disconnects >= 1, String(disconnects));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
