import { classes } from "./styles/classes";
import { I18nProvider, useI18n } from "./i18n/provider";
import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  Navigate,
  Outlet,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./app/auth";
import { Login, Activate } from "./features/auth/pages";
import { Library, Detail } from "./features/library/pages";
import { Account } from "./features/account/page";
import { LanguagePreference } from "./features/account/LanguagePreference";
const SoloPage = lazy(() =>
  import("./features/watch-solo/page").then((module) => ({
    default: module.SoloPage,
  })),
);
const RoomPage = lazy(() =>
  import("./features/room/page").then((module) => ({
    default: module.RoomPage,
  })),
);
const admin = () => import("./features/admin/pages");
const AdminNav = lazy(() =>
    admin().then((module) => ({ default: module.AdminNav })),
  ),
  AddVideo = lazy(() =>
    admin().then((module) => ({ default: module.AddVideo })),
  ),
  EditVideo = lazy(() =>
    admin().then((module) => ({ default: module.EditVideo })),
  ),
  Accounts = lazy(() =>
    admin().then((module) => ({ default: module.Accounts })),
  ),
  SystemPage = lazy(() =>
    admin().then((module) => ({ default: module.SystemPage })),
  ),
  DrivePage = lazy(() =>
    admin().then((module) => ({ default: module.DrivePage })),
  );

function Protected({ owner = false }: { owner?: boolean }) {
  const { t } = useI18n();
  const a = useAuth();
  if (a.loading) return <p role="status">{t("app.loadingSession")}</p>;
  if (!a.user) return <Navigate to="/login" replace />;
  if (owner && a.user.role !== "OWNER") return <Navigate to="/" replace />;
  if (a.user.mustChangePassword && location.pathname !== "/account")
    return <Navigate to="/account" replace />;
  return <Outlet />;
}
function Layout() {
  const { t } = useI18n();
  const a = useAuth();
  return (
    <>
      <a className={classes("skip")} href="#main">
        {t("nav.skip")}
      </a>
      <header>
        <Link className={classes("brand")} to="/">
          {"◉ "}
          {t("app.brand")}
        </Link>
        <nav aria-label={t("nav.main")}>
          <Link to="/">{t("nav.library")}</Link>
          <Link to="/room">{t("nav.room")}</Link>
          <Link to="/account">{a.user?.displayName}</Link>
          {a.user?.role === "OWNER" && (
            <Link to="/admin">{t("nav.admin")}</Link>
          )}
          <button onClick={() => void a.logout()}>{t("nav.logout")}</button>
          <LanguagePreference />
        </nav>
      </header>
      <main id="main" className={classes("main")}>
        <Outlet />
      </main>
      <footer>{t("app.footer")}</footer>
    </>
  );
}
const cache = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});
function App() {
  const { t } = useI18n();
  return (
    <Suspense fallback={<p role="status">{t("app.loadingSession")}</p>}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/activate" element={<Activate />} />
        <Route element={<Protected />}>
          <Route element={<Layout />}>
            <Route path="/" element={<Library />} />
            <Route path="/video/:id" element={<Detail />} />
            <Route path="/watch/:id" element={<SoloPage />} />
            <Route path="/room" element={<RoomPage />} />
            <Route path="/account" element={<Account />} />
            <Route element={<Protected owner />}>
              <Route
                path="/admin"
                element={
                  <>
                    <AdminNav />
                    <h1>{t("admin.overview")}</h1>
                    <p>{t("admin.overviewHelp")}</p>
                    <Link
                      className={classes("button primary")}
                      to="/admin/videos/new"
                    >
                      {t("admin.addVideo")}
                    </Link>
                    <SystemPage embedded />
                  </>
                }
              />
              <Route
                path="/admin/videos"
                element={
                  <>
                    <AdminNav />
                    <Library admin />
                  </>
                }
              />
              <Route path="/admin/videos/new" element={<AddVideo />} />
              <Route path="/admin/videos/:id" element={<EditVideo />} />
              <Route path="/admin/accounts" element={<Accounts />} />
              <Route path="/admin/storage" element={<SystemPage storage />} />
              <Route path="/admin/system" element={<SystemPage />} />
              <Route path="/admin/integrations" element={<DrivePage />} />
            </Route>
            <Route
              path="*"
              element={
                <>
                  <h1>{t("app.notFound")}</h1>
                  <Link to="/">{t("app.backLibrary")}</Link>
                </>
              }
            />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <QueryClientProvider client={cache}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </I18nProvider>,
);
