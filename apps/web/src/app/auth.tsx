import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { api, setCsrf, type Profile } from "./api";
import { useI18n } from "../i18n/provider";
import { accountLocale } from "../i18n/index";
import type { Locale } from "../i18n/types";
interface Auth {
  user: Profile | null;
  loading: boolean;
  refresh: () => Promise<void>;
  accept: (u: Profile) => void;
  logout: () => Promise<void>;
  changeLocale: (locale: Locale) => Promise<void>;
  localeSaving: boolean;
}
const Context = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const { setLocale, locale } = useI18n();
  const [user, setUser] = useState<Profile | null>(null),
    [loading, setLoading] = useState(true),
    [localeSaving, setLocaleSaving] = useState(false);
  const accept = (u: Profile) => {
    setLocale(accountLocale(u.role, u.preferences.locale));
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
        localeSaving,
        changeLocale: async (next) => {
          if (localeSaving) return;
          const previous = locale;
          setLocaleSaving(true);
          setLocale(next, true);
          try {
            accept(
              await api<Profile>("/account", "PATCH", {
                preferences: { locale: next },
              }),
            );
          } catch (error) {
            setLocale(previous, true);
            throw error;
          } finally {
            setLocaleSaving(false);
          }
        },
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
