import http from "node:http";
import streamDeck from "@elgato/streamdeck";
import { OpenCodeStatus } from "./actions/opencode-status";

const statusAction = new OpenCodeStatus();
streamDeck.actions.registerAction(statusAction);

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST" || req.url !== "/state") {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = "";

  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();

    if (body.length > 4096) {
      req.destroy();
    }
  });

  req.on("end", () => {
    try {
      const input: unknown = JSON.parse(body);

      if (
        typeof input !== "object" ||
        input === null ||
        !("instance" in input) ||
        !Number.isSafeInteger(input.instance) ||
        (input.instance as number) < 0 ||
        !("state" in input) ||
        !["green", "yellow", "red"].includes(String(input.state))
      ) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Expected { instance: non-negative integer, state: green|yellow|red }" }));
        return;
      }

      const instance = input.instance as number;
      const state = input.state as "green" | "yellow" | "red";

      void statusAction.update(instance, state).catch((error) => {
        streamDeck.logger.error(`Could not update status key: ${String(error)}`);
      });

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });
});

server.on("error", (error) => {
  streamDeck.logger.error(`HTTP server failed: ${String(error)}`);
});

server.listen(8765, "127.0.0.1", () => {
  streamDeck.logger.info("OpenCode status listening on 127.0.0.1:8765");
});

streamDeck.connect();
