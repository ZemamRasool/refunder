// Starts the website. By default it also runs the background worker in the same
// process (WORKER_INLINE=true). For more traffic, set WORKER_INLINE=false and run
// `npm run worker` separately (as many copies as you like).
import { bootstrap } from "./bootstrap.js";
import { createApp } from "./app.js";

const { config, prisma, deps, worker, purge } = await bootstrap();
const app = createApp(deps);

if (config.AUTH_MODE === "dev") console.warn("⚠  AUTH_MODE=dev: anyone can log in as any email. Local testing only.");
if (!config.GEMINI_API_KEY) console.warn("⚠  GEMINI_API_KEY is empty: receipts will be marked 'failed' and letters use the plain template.");
if (config.ADMIN_EMAILS.length === 0) console.warn("⚠  ADMIN_EMAILS is empty: nobody can open /admin.");

if (config.WORKER_INLINE) {
  worker.start();
  void purge();
  setInterval(purge, 24 * 60 * 60 * 1000).unref();
}

const server = app.listen(config.PORT, () => {
  console.log(`RefundRadar running on port ${config.PORT} (${config.PUBLIC_BASE_URL})`);
});

const shutdown = async () => {
  worker.stop();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
