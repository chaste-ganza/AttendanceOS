/**
 * rfid-reader.js — Web Serial client for the USB RFID reader.
 *
 * The reader (ESP8266/Arduino + MFRC522) is plugged into the teacher's own
 * computer, not the machine running Flask. This module owns that serial
 * connection in the browser and speaks the same newline protocol the
 * firmware already implements:
 *
 *   sent      ON | OFF | STATUS | ASSIGN
 *   received  BOOT: ... | SYSTEM: ON | SYSTEM: OFF | STATUS: ON|OFF
 *             ASSIGN: WAITING | ASSIGN: DONE | UID: <HEX> | ERROR: ...
 *
 * It contains no attendance logic: it answers "which card was scanned, and
 * when", and hands the UID to the caller. The server validates and stores it.
 *
 * Browser support: Chrome, Edge and other Chromium browsers on desktop.
 * Web Serial requires a secure context (https:// or http://localhost).
 */

export const READER_BAUD_RATE = 115200;

// Boards like the ESP8266 reset when the port opens; the firmware needs a
// moment before it can accept commands (matches the old pyserial startup
// delay of 2 s).
export const READER_BOOT_DELAY_MS = 1600;

export const ReaderMode = Object.freeze({
  NORMAL: "NORMAL",
  ASSIGN: "ASSIGN",
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isSerialSupported() {
  return typeof navigator !== "undefined" && Boolean(navigator.serial);
}

/** Strip spaces and upper-case, matching the firmware and the backend. */
export function normalizeUid(raw) {
  return String(raw ?? "").replace(/\s+/g, "").trim().toUpperCase();
}

/**
 * Turn one firmware line into a structured event.
 *
 * Kinds: card | assign-card | system-on | system-off | status |
 *        assign-waiting | assign-done | boot | error | ignore | unknown
 */
export function parseReaderLine(rawLine, mode = ReaderMode.NORMAL) {
  const line = String(rawLine ?? "").trim();
  if (!line) return { kind: "ignore" };

  const upper = line.toUpperCase();
  const separator = line.indexOf(":");
  const value = separator >= 0 ? line.slice(separator + 1).trim() : "";

  if (upper.startsWith("UID:")) {
    const uid = normalizeUid(value);
    if (!uid) return { kind: "error", message: "The reader reported an empty card UID." };
    return { kind: mode === ReaderMode.ASSIGN ? "assign-card" : "card", uid };
  }
  if (upper === "SYSTEM: ON") return { kind: "system-on" };
  if (upper === "SYSTEM: OFF") return { kind: "system-off" };
  if (upper.startsWith("STATUS:")) return { kind: "status", message: value };
  if (upper === "ASSIGN: WAITING") return { kind: "assign-waiting" };
  if (upper === "ASSIGN: DONE") return { kind: "assign-done" };
  if (upper.startsWith("BOOT:")) return { kind: "boot", message: value };
  if (upper.startsWith("ERROR:")) return { kind: "error", message: value };
  // Second line of every ON/OFF acknowledgement — already handled above.
  if (upper.startsWith("RFID READER:")) return { kind: "ignore" };

  return { kind: "unknown", message: line };
}

export class RfidReader {
  /**
   * @param {object} handlers
   * @param {(uid: string) => void} [handlers.onCard]        normal-mode scan
   * @param {(message: string) => void} [handlers.onError]   firmware/parse error
   * @param {(error: Error) => void} [handlers.onDisconnect] cable pulled / stream failed
   * @param {(line: string, event: object) => void} [handlers.onLog]
   * @param {() => void} [handlers.onReady]                  firmware confirmed ON
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.port = null;
    this.reader = null;
    this.readLoopPromise = null;
    this.buffer = "";
    this.mode = ReaderMode.NORMAL;
    this.connected = false;
    this.reading = false;
    this.pendingAssign = null;
  }

  get isConnected() {
    return this.connected;
  }

  getInfo() {
    const info = this.port?.getInfo?.() ?? {};
    return {
      usbVendorId: info.usbVendorId ?? null,
      usbProductId: info.usbProductId ?? null,
    };
  }

  /** Ask the teacher to pick a port, then open it. Must run from a click. */
  async connect() {
    if (!isSerialSupported()) {
      throw new Error("This browser cannot open USB readers. Use Chrome or Edge on a desktop computer.");
    }
    const port = await navigator.serial.requestPort();
    await this.open(port);
    return this.getInfo();
  }

  /** Re-open a previously authorised port (e.g. after a page reload). */
  async reconnect() {
    if (!isSerialSupported()) return false;
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return false;
    await this.open(ports[0]);
    return true;
  }

  async open(port) {
    await port.open({ baudRate: READER_BAUD_RATE });
    this.port = port;
    this.connected = true;
    this.reading = true;
    this.mode = ReaderMode.NORMAL;
    this.buffer = "";
    this.readLoopPromise = this.readLines(port);

    // Let the board finish rebooting before the first command.
    await delay(READER_BOOT_DELAY_MS);
    await this.send("ON");
  }

  async send(command) {
    if (!this.port?.writable) throw new Error("The RFID reader is not connected.");
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(`${command}\n`));
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // Stream already closed by a disconnect.
      }
    }
  }

  /**
   * Enter ASSIGN mode and resolve with the next card UID.
   * The firmware leaves ASSIGN mode by itself after one card.
   */
  requestAssignScan(timeoutMs = 45000) {
    if (!this.connected) return Promise.reject(new Error("Connect the RFID reader first."));
    if (this.pendingAssign) return Promise.reject(new Error("A card scan is already in progress."));

    this.mode = ReaderMode.ASSIGN;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAssign = null;
        this.mode = ReaderMode.NORMAL;
        this.send("ON").catch(() => {});
        reject(new Error("No card was scanned in time. Tap the card on the reader and try again."));
      }, timeoutMs);

      this.pendingAssign = { resolve, reject, timer };
      this.send("ASSIGN").catch((error) => {
        clearTimeout(timer);
        this.pendingAssign = null;
        this.mode = ReaderMode.NORMAL;
        reject(error);
      });
    });
  }

  cancelAssign() {
    this.mode = ReaderMode.NORMAL;
    const pending = this.pendingAssign;
    if (!pending) return;
    this.pendingAssign = null;
    clearTimeout(pending.timer);
    pending.reject(new Error("Card scan cancelled."));
    // The firmware has no timeout of its own; ON resets it to normal mode.
    this.send("ON").catch(() => {});
  }

  async disconnect() {
    this.reading = false;
    this.cancelAssign();

    try {
      await this.send("OFF");
    } catch {
      // Port may already be gone.
    }
    try {
      await this.reader?.cancel();
    } catch {
      // Reader already released.
    }
    try {
      await this.readLoopPromise;
    } catch {
      // Loop ended with a disconnect error; nothing to clean up.
    }
    try {
      await this.port?.close();
    } catch {
      // Already closed by the OS after an unplug.
    }

    this.port = null;
    this.reader = null;
    this.readLoopPromise = null;
    this.connected = false;
  }

  async readLines(port) {
    const decoder = new TextDecoder();
    let ended = false;

    while (this.reading && port.readable) {
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            // The port closed underneath us (cable pulled, board reset).
            // Leave the loop: re-reading a closed stream would spin forever.
            ended = true;
            break;
          }
          this.feed(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        if (this.reading) this.fail(error);
      } finally {
        this.reader = null;
        try {
          reader.releaseLock();
        } catch {
          // The stream was errored and the lock released by the platform.
        }
      }
      if (ended) break;
    }

    if (ended && this.reading && this.connected) {
      this.fail(new Error("The serial stream ended. The reader may have been unplugged."));
    }
  }

  feed(text) {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  handleLine(line) {
    const event = parseReaderLine(line, this.mode);
    this.handlers.onLog?.(line, event);

    switch (event.kind) {
      case "card":
        this.handlers.onCard?.(event.uid);
        break;
      case "assign-card": {
        const pending = this.pendingAssign;
        this.mode = ReaderMode.NORMAL;
        this.pendingAssign = null;
        if (!pending) {
          this.handlers.onError?.("A card was scanned for assignment, but no assignment was in progress.");
          break;
        }
        clearTimeout(pending.timer);
        pending.resolve(event.uid);
        break;
      }
      case "assign-waiting":
        this.handlers.onAssignWaiting?.();
        break;
      case "assign-done":
        if (this.mode === ReaderMode.ASSIGN) this.mode = ReaderMode.NORMAL;
        break;
      case "system-on":
        this.handlers.onReady?.();
        break;
      case "error":
        this.handlers.onError?.(event.message || "The reader reported an error.");
        break;
      default:
        break;
    }
  }

  fail(error) {
    if (!this.connected) return;
    this.connected = false;
    this.reading = false;

    const pending = this.pendingAssign;
    this.pendingAssign = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.handlers.onDisconnect?.(error);
  }
}
