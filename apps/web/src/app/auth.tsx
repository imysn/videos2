import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { api, setCsrf, type Profile } from "./api";
interface Auth {
  user: Profile | null;
  loading: boolean;
  refresh: () => Promise<void>;
  accept: (u: Profile) => void;
  logout: () => Promise<void>;
}
const Context = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null),
    [loading, setLoading] = useState(true);
  const accept = (u: Profile) => {
    if (u.csrf) setCsrf(u.csrf);
    setUser(u);
  };
  const refresh = async () => {
    try {
      accept(await api<Profile>("/auth/me"));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <Context.Provider
      value={{
        user,
        loading,
        accept,
        refresh,
        logout: async () => {
          await api("/auth/logout", "POST");
          setUser(null);
          setCsrf("");
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAuth() {
  const a = useContext(Context);
  if (!a) throw new Error("Auth provider required");
  return a;
}
