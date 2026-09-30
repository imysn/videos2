import { loadConfig } from "../apps/api/src/infrastructure/config.js";
const c = loadConfig();
console.log(
  JSON.stringify({
    valid: true,
    mode: c.APP_ENV,
    origin: c.origin,
    googleConfigured: c.googleConfigured,
    secureCookies: c.COOKIE_SECURE === "true",
  }),
);
