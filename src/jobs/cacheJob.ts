import cron from "node-cron";
import { cacheLimpiarExpirados } from "../utils/dbCache";
import { logger } from "../logger";

export function startCacheJob() {
  cron.schedule("0 * * * *", async () => {
    await cacheLimpiarExpirados();
  }, {
    timezone: "America/Mexico_City",
  });

  logger.info("cache.job.registrado (cada hora)");
}
