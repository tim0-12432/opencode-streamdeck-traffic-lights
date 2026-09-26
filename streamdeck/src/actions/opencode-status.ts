import { spawn } from "node:child_process";
import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";

type Color = "green" | "yellow" | "red";

type Settings = {
  instance?: number;
  greenImage?: string;
  yellowImage?: string;
  redImage?: string;
  tapMode?: "none" | "url" | "program";
  tapUrl?: string;
  program?: string;
  arguments?: string; // JSON array, e.g. ["--window", "opencode-2"]
};

const latest = new Map<number, Color>();

const defaults: Record<Color, string> = {
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
};

function fallbackImage(color: Color): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
    `<rect width="144" height="144" fill="#171717"/>` +
    `<circle cx="72" cy="72" r="49" fill="${defaults[color]}"/>` +
    `</svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function imageFor(settings: Settings, color: Color): string {
  const selected = {
    green: settings.greenImage,
    yellow: settings.yellowImage,
    red: settings.redImage,
  }[color];

  // The property inspector supplies image data URLs, not filesystem paths.
  return selected?.startsWith("data:image/") ? selected : fallbackImage(color);
}

@action({ UUID: "com.example.opencodestatus.status" })
export class OpenCodeStatus extends SingletonAction<Settings> {
  async update(instance: number, state: Color): Promise<void> {
    latest.set(instance, state);

    // `this.actions` contains the currently visible copies of this action.
    const tasks: Promise<void>[] = [];

    this.actions.forEach((key) => {
      if (!key.isKey()) return;

      tasks.push(
        (async () => {
          const settings = await key.getSettings();
          if ((settings.instance ?? 1) === instance) {
            await key.setImage(imageFor(settings, state));
          }
        })(),
      );
    });

    await Promise.all(tasks);
  }

  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
    if (!ev.action.isKey()) return;

    const settings = ev.payload.settings;
    const state = latest.get(settings.instance ?? 1) ?? "green";
    await ev.action.setImage(imageFor(settings, state));
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<Settings>,
  ): Promise<void> {
    if (!ev.action.isKey()) return;

    const settings = ev.payload.settings;
    const state = latest.get(settings.instance ?? 1) ?? "green";
    await ev.action.setImage(imageFor(settings, state));
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const settings = ev.payload.settings;

    try {
      if (settings.tapMode === "url" && settings.tapUrl) {
        const url = new URL(settings.tapUrl);

        if (!["http:", "https:"].includes(url.protocol)) {
          throw new Error("Only http(s) URLs are accepted");
        }

        const opener =
          process.platform === "win32"
            ? { command: "explorer.exe", args: [url.href] }
            : { command: "open", args: [url.href] }; // macOS

        const child = spawn(opener.command, opener.args, {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", (error) => streamDeck.logger.error(String(error)));
        child.unref();
      }

      if (settings.tapMode === "program" && settings.program) {
        const args: unknown = JSON.parse(settings.arguments || "[]");

        if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
          throw new Error("Arguments must be a JSON array of strings");
        }

        const child = spawn(settings.program, args, {
          detached: true,
          stdio: "ignore",
          shell: false,
        });
        child.on("error", (error) => streamDeck.logger.error(String(error)));
        child.unref();
      }
    } catch (error) {
      streamDeck.logger.error(`Tap action failed: ${String(error)}`);
      await ev.action.showAlert();
    }
  }
}
