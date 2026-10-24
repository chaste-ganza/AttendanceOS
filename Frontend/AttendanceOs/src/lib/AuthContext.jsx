import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUser(await api.auth.me());
    } catch (requestError) {
      if (requestError.status === 401) {
        setUser(null);
      } else {
        setError(requestError);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => active && refresh());
    return () => { active = false; };
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
      setUser(null);
      navigate("/login", { replace: true });
    } catch (requestError) {
      setError(requestError);
    }
  }, [navigate]);

  const value = useMemo(() => ({
    user,
    loading,
    error,
    isAuthenticated: Boolean(user),
    logout,
    refresh,
  }), [user, loading, error, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
