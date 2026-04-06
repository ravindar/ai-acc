import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { createServices } from "./lib/services.js";

async function main() {
  const config = getConfig();
  const services = await createServices(config);
  const app = await createApp(services);
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    app.log.info({ signal }, "shutting down control plane");

    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error, signal }, "failed to shut down cleanly");
      process.exitCode = 1;
    }
  };

  try {
    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });

    await app.listen({
      host: config.host,
      port: config.port,
    });

    app.log.info(
      {
        host: config.host,
        port: config.port,
        autoMigrate: config.autoMigrate,
      },
      "control plane listening",
    );
  } catch (error) {
    await app.close().catch(async () => {
      await services.db.close();
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
