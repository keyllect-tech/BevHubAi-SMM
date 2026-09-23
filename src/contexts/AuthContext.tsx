import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, UNAUTHORIZED_EVENT } from '@/lib/api';
import type { User, Workspace } from '@/types';

interface AuthContextType {
  user: User | null;
  workspace: Workspace | null;
  loading: boolean;
  signUp: (email: string, password: string, name: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Неизвестная ошибка. Попробуйте ещё раз.');

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);

  const clear = useCallback(() => {
    setUser(null);
    setWorkspace(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    api
      .me()
      .then((data) => {
        if (!mounted) return;
        setUser(data.user);
        setWorkspace(data.workspace);
      })
      .catch((err) => console.error('[AUTH] session check failed:', errorMessage(err)))
      .finally(() => {
        if (mounted) setLoading(false);
      });

    window.addEventListener(UNAUTHORIZED_EVENT, clear);
    return () => {
      mounted = false;
      window.removeEventListener(UNAUTHORIZED_EVENT, clear);
    };
  }, [clear]);

  const signUp = async (email: string, password: string, name: string) => {
    try {
      const data = await api.register(name, email, password);
      setUser(data.user);
      setWorkspace(data.workspace);
      return { error: null };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      const data = await api.login(email, password);
      setUser(data.user);
      setWorkspace(data.workspace);
      return { error: null };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  };

  const signOut = async () => {
    try {
      await api.logout();
    } catch (err) {
      console.warn('[AUTH] logout request failed:', errorMessage(err));
    }
    clear();
  };

  const refreshWorkspace = async () => {
    try {
      const data = await api.me();
      setUser(data.user);
      setWorkspace(data.workspace);
    } catch (err) {
      console.error('[AUTH] refresh failed:', errorMessage(err));
    }
  };

  return (
    <AuthContext.Provider value={{ user, workspace, loading, signUp, signIn, signOut, refreshWorkspace }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
