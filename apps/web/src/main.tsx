import { classes } from "./styles/classes";
import { ui } from "./i18n/es";
import { createRoot } from "react-dom/client";
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
import { SoloPage } from "./features/watch-solo/page";
import { RoomPage } from "./features/room/page";
import {
  AdminNav,
  AddVideo,
  EditVideo,
  Accounts,
  SystemPage,
  DrivePage,
} from "./features/admin/pages";
import { es } from "./i18n/es";

function Protected({ owner = false }: { owner?: boolean }) {
  const a = useAuth();
  if (a.loading) return <p role="status">{ui.cargando_sesion_5fc719}</p>;
  if (!a.user) return <Navigate to="/login" replace />;
  if (owner && a.user.role !== "OWNER") return <Navigate to="/" replace />;
  if (a.user.mustChangePassword && location.pathname !== "/account")
    return <Navigate to="/account" replace />;
  return <Outlet />;
}
function Layout() {
  const a = useAuth();
  return (
    <>
      <a className={classes("skip")} href="#main">
        {ui.saltar_al_contenido_fdab69}
      </a>
      <header>
        <Link className={classes("brand")} to="/">
          {ui._ee201a}
          {es.brand}
        </Link>
        <nav aria-label={ui.principal_afc19f}>
          <Link to="/">{es.library}</Link>
          <Link to="/room">{es.room}</Link>
          <Link to="/account">{a.user?.displayName}</Link>
          {a.user?.role === "OWNER" && <Link to="/admin">{es.admin}</Link>}
          <button onClick={() => void a.logout()}>{ui.salir_93fffb}</button>
        </nav>
      </header>
      <main id="main" className={classes("main")}>
        <Outlet />
      </main>
      <footer>{ui.vuestro_espacio_privado_sin_registro_06fd55}</footer>
    </>
  );
}
const cache = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={cache}>
    <BrowserRouter>
      <AuthProvider>
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
                      <h1>{ui.tu_biblioteca_cuidada_por_ti_39dd20}</h1>
                      <p>{ui.anade_contenido_comprueba_sus_fuentes_44917d}</p>
                      <Link
                        className={classes("button primary")}
                        to="/admin/videos/new"
                      >
                        {ui.anadir_video_d471c2}
                      </Link>
                      <SystemPage />
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
                    <h1>{ui.pagina_no_encontrada_66d468}</h1>
                    <Link to="/">{ui.volver_a_vuestra_biblioteca_c8413d}</Link>
                  </>
                }
              />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </QueryClientProvider>,
);
