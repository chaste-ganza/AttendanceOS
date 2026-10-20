import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";

const ReaderContext = createContext(null);

export function ReaderProvider({ children }) {
  const [reader, setReader] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const status = await api.reader.status();
      setReader(status);
      setError(null);
    } catch (requestError) {
      setError(requestError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => active && refresh());
    const timer = window.setInterval(() => active && refresh(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const value = useMemo(() => ({
    isOnline: Boolean(reader?.reader_online),
    readerPort: reader?.reader_port || null,
    loading,
    error,
    refresh,
  }), [reader, loading, error, refresh]);

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>;
}

export function useReader() {
  const value = useContext(ReaderContext);
  if (!value) throw new Error("useReader must be used inside ReaderProvider");
  return value;
}
