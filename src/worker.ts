// Background worker on its own (npm run worker). Reads receipts with AI, runs the rules,
// and does the daily 30-day cleanup. Use with WORKER_INLINE=false on the web server.
import { bootstrap } from "./bootstrap.js";

const { prisma, worker, purge } = await bootstrap();
worker.start(1000);
void purge();
setInterval(purge, 24 * 60 * 60 * 1000);
console.log("RefundRadar worker started");

const shutdown = async () => {
  worker.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
