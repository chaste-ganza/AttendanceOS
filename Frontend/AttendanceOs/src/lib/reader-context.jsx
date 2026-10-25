import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { RfidReader, isSerialSupported } from "@/lib/rfid-reader";

const ReaderContext = createContext(null);

const hex = (value) => (value == null ? null : value.toString(16).padStart(4, "0"));

function friendlyError(error) {
  switch (error?.name) {
    case "NotFoundError":
      return "No reader was selected. Click Connect and choose your USB device.";
    case "SecurityError":
    case "NotAllowedError":
      return "The browser blocked access to the serial port. Click Connect again and allow access.";
    case "InvalidStateError":
      return "That serial port is already open in another tab or program.";
    case "NetworkError":
      return "The reader could not be opened. Close the Arduino IDE serial monitor and try again.";
    default:
      return error?.message || "The RFID reader could not be opened.";
  }
}

export function ReaderProvider({ children }) {
  const queryClient = useQueryClient();
  const [supported] = useState(() => isSerialSupported());
  const [status, setStatus] = useState("disconnected"); // disconnected | connecting | connected
  const [error, setError] = useState(null);
  const [portInfo, setPortInfo] = useState(null);
  const [lastScan, setLastScan] = useState(null);

  const readerRef = useRef(null);
  const scanIdRef = useRef(0);
  const mountedRef = useRef(true);

  /**
   * Every normal-mode card tap is posted to the server, which validates it
   * against the single OPEN session. The result is kept here so the session
   * page and its live table can react without polling.
   */
  const recordScan = useCallback(
    async (uid) => {
      const id = (scanIdRef.current += 1);
      try {
        const result = await api.scans.record(uid);
        if (!mountedRef.current) return;
        setLastScan({ id, uid, result, error: null, at: Date.now() });
        if (result.outcome === "SUCCESS" || result.outcome === "DUPLICATE") {
          queryClient.invalidateQueries({ queryKey: ["classroom"] });
        }
      } catch (requestError) {
        if (!mountedRef.current) return;
        setLastScan({
          id,
          uid,
          result: null,
          error: requestError.message || "The scan could not be recorded.",
          at: Date.now(),
        });
      }
    },
    [queryClient]
  );

  const createReader = useCallback(
    () =>
      new RfidReader({
        onCard: recordScan,
        onError: (message) => setError(message),
        onDisconnect: () => {
          readerRef.current = null;
          setStatus("disconnected");
          setPortInfo(null);
          setError("The RFID reader was disconnected. Plug it back in and connect again.");
        },
      }),
    [recordScan]
  );

  const connect = useCallback(async () => {
    if (!supported) {
      setError("This browser cannot open USB readers. Use Chrome or Edge on a desktop computer.");
      return false;
    }
    if (readerRef.current?.isConnected) return true;

    setStatus("connecting");
    setError(null);
    const reader = readerRef.current ?? createReader();
    readerRef.current = reader;

    try {
      const info = await reader.connect();
      if (!mountedRef.current) {
        await reader.disconnect();
        return false;
      }
      setPortInfo(info);
      setStatus("connected");
      return true;
    } catch (connectError) {
      if (readerRef.current === reader) readerRef.current = null;
      setStatus("disconnected");
      setError(friendlyError(connectError));
      return false;
    }
  }, [createReader, supported]);

  const disconnect = useCallback(async () => {
    const reader = readerRef.current;
    readerRef.current = null;
    setStatus("disconnected");
    setPortInfo(null);
    setError(null);
    if (reader) {
      try {
        await reader.disconnect();
      } catch {
        // Port already closed.
      }
    }
  }, []);

  const requestAssignScan = useCallback(async (timeoutMs = 45000) => {
    const reader = readerRef.current;
    if (!reader?.isConnected) throw new Error("Connect the RFID reader first.");
    return reader.requestAssignScan(timeoutMs);
  }, []);

  const cancelAssign = useCallback(() => {
    readerRef.current?.cancelAssign();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // Re-open a previously authorised reader so a page reload does not force
  // the teacher to pick the port again. Failure leaves the UI disconnected.
  useEffect(() => {
    if (!supported) return undefined;
    let active = true;
    const reader = createReader();

    (async () => {
      try {
        const ports = await navigator.serial.getPorts();
        if (!active || !ports.length || readerRef.current) return;
        readerRef.current = reader;
        const reconnected = await reader.reconnect();
        if (!active) return;
        if (!reconnected) {
          if (readerRef.current === reader) readerRef.current = null;
          return;
        }
        setPortInfo(reader.getInfo());
        setStatus("connected");
      } catch {
        if (readerRef.current === reader) readerRef.current = null;
        if (active) setStatus("disconnected");
      }
    })();

    return () => {
      active = false;
    };
  }, [createReader, supported]);

  // The OS reports unplugged devices; mirror that in the UI.
  useEffect(() => {
    if (!supported) return undefined;
    const handleDisconnect = (event) => {
      const port = readerRef.current?.port;
      if (!port || (event.target && event.target !== port)) return;
      readerRef.current = null;
      setStatus("disconnected");
      setPortInfo(null);
      setError("The RFID reader was disconnected. Plug it back in and connect again.");
    };
    navigator.serial.addEventListener("disconnect", handleDisconnect);
    return () => navigator.serial.removeEventListener("disconnect", handleDisconnect);
  }, [supported]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      readerRef.current?.disconnect();
      readerRef.current = null;
    };
  }, []);

  const value = useMemo(
    () => ({
      supported,
      status,
      connected: status === "connected",
      connecting: status === "connecting",
      portLabel: portInfo
        ? `USB ${hex(portInfo.usbVendorId) ?? "----"}:${hex(portInfo.usbProductId) ?? "----"}`
        : null,
      error,
      lastScan,
      connect,
      disconnect,
      requestAssignScan,
      cancelAssign,
      clearError,
    }),
    [supported, status, portInfo, error, lastScan, connect, disconnect, requestAssignScan, cancelAssign, clearError]
  );

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}

export function useReader() {
  const value = useContext(ReaderContext);
  if (!value) throw new Error("useReader must be used inside ReaderProvider");
  return value;
}
