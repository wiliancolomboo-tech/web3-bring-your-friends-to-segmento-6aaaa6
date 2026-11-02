import { Command } from "commander";
import { SegmentoIndexer } from "./indexer";
import winston from "winston";

const logger = winston.createLogger({
  transports: [new winston.transports.Console()],
});

const program = new Command();

program
  .name("segmento-friends-cli")
  .description("Segmento Friends Protocol CLI & Daemon Runner")
  .version("1.0.0");

program
  .command("daemon")
  .description("Launch real-time WebSocket Indexer daemon & Enterprise bridge")
  .action(async () => {
    logger.info("Initializing Segmento Event Daemon...");
    const indexer = new SegmentoIndexer();
    await indexer.start();
  });

program
  .command("inspect-profile")
  .description("Inspect an on-chain referrer or referee profile")
  .argument("<address>", "Solana Public Key to query")
  .action((address: string) => {
    logger.info(`Inspecting state for address: ${address}...`);
    // State inspection routine
  });

program.parse(process.argv);