import { loadConfig } from "./infrastructure/config.js";
import { createApp } from "./server.js";
const config = loadConfig();
const server = await createApp(config);
await server.app.listen({
  port: config.PORT,
  host: config.APP_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void server.app.close();
  });
