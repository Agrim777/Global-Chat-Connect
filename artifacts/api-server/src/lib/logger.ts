import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
});

process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "Unhandled promise rejection");
});
