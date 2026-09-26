import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk";

export const StreamDeckStatus: Plugin = async () => {
    const instance = Number(process.env.OPENCODE_STREAMDECK_INSTANCE ?? "1");

    if (!Number.isSafeInteger(instance) || instance < 0) {
        throw new Error("OPENCODE_STREAMDECK_INSTANCE must be a non-negative integer");
    }

    const endpoint = "http://127.0.0.1:8765/state";
    const sessions = new Map();
    let lastSent: string | undefined;

    function getSession(id: string) {
        if (!sessions.has(id)) {
        sessions.set(id, { busy: false, active: false, pendingInput: false });
        }
        return sessions.get(id);
    }

    function publish() {
        // One OpenCode process has one instance ID. If several sessions are busy
        // within it, display the most active state.
        const all = [...sessions.values()];
        const state = all.some((s) => s.busy && s.active && !s.pendingInput)
        ? "red"
        : all.some((s) => s.busy && !s.pendingInput)
            ? "yellow"
            : "green";

        if (state === lastSent) return;
        lastSent = state;

        // Do not block the OpenCode event loop on an unavailable Stream Deck.
        void fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance, state }),
        signal: AbortSignal.timeout(700),
        }).catch(() => {
        // Stream Deck may simply not be running.
        // Clear deduplication so a later event retries.
        if (lastSent === state) lastSent = undefined;
        });
    }

    publish();

    return {
        event: async ({ event }: { event: Event }) => {
            switch (event.type) {
                case "session.status": {
                const { sessionID, status } = event.properties;
                const s = getSession(sessionID);
                s.busy = status.type !== "idle";

                if (!s.busy) s.active = false;
                    publish();
                    break;
                }

                case "session.idle": {
                    const s = getSession(event.properties.sessionID);
                    s.busy = false;
                    s.active = false;
                    publish();
                    break;
                }

                case "message.part.updated": {
                    const part = event.properties.part;
                    const s = getSession(part.sessionID);

                    if (
                        (part.type === "tool" &&
                        (part.state.status === "pending" ||
                            part.state.status === "running")) ||
                        (part.type === "text" && !part.synthetic && !part.ignored)
                    ) {
                        s.busy = true;
                        s.active = true;
                        publish();
                    }
                    break;
                }

                case "session.deleted": {
                    sessions.delete(event.properties.info.id);
                    publish();
                    break;
                }
            }
        },
    };
};
