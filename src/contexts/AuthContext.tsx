import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { Workspace } from '@/types';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  workspace: Workspace | null;
  loading: boolean;
  signUp: (email: string, password: string, name: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function getNetworkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
      return 'Не удаётся подключиться к серверу. Проверьте интернет или настройки приложения.';
    }
    return err.message;
  }
  return 'Неизвестная ошибка. Попробуйте ещё раз.';
}


export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);

  const loadWorkspace = async (userId: string) => {
    const { data } = await supabase
      .from('workspaces')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    setWorkspace(data as Workspace | null);
  };

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        loadWorkspace(session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      (async () => {
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          await loadWorkspace(session.user.id);
        } else {
          setWorkspace(null);
        }
        setLoading(false);
      })();
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const signUp = async (email: string, password: string, name: string) => {
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } },
      });
      if (error) return { error: error.message };
      if (data.user) {
        await supabase.from('workspaces').insert({
          user_id: data.user.id,
          name: `${name}'s Workspace`,
          demo_mode: true,
        });
        await supabase.from('subscriptions').insert({
          workspace_id: (await supabase.from('workspaces').select('id').eq('user_id', data.user.id).maybeSingle()).data?.id,
          plan: 'starter',
          monthly_limit: 15,
        });
        await loadWorkspace(data.user.id);
      }
      return { error: null };
    } catch (err) {
      return { error: getNetworkErrorMessage(err) };
    }
  };

  const signIn = async (email: string, password: string) => {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return { error: error.message };
      return { error: null };
    } catch (err) {
      return { error: getNetworkErrorMessage(err) };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setWorkspace(null);
  };

  const refreshWorkspace = async () => {
    if (user) await loadWorkspace(user.id);
  };

  return (
    <AuthContext.Provider value={{ user, session, workspace, loading, signUp, signIn, signOut, refreshWorkspace }}>
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
