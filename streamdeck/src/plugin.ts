import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import streamDeck from '@elgato/streamdeck';
import {
  MAX_BODY_BYTES,
  PATH,
  STALE_MS,
  SWEEP_MS,
  isState,
  resolveConfig,
  type State,
} from '../../shared/contract';
import { MAX_TRACKED_INSTANCES, OpenCodeStatus } from './actions/opencode-status';

/*
 * TODO(original artwork): all four images below are still Elgato's stock
 * `Counter` plugin template files, referenced by the manifest:
 *
 *   imgs/actions/counter/icon          -- action icon in the action list
 *   imgs/actions/counter/key           -- the key's default state image
 *   imgs/plugin/category-icon         -- the plugin's category icon
 *   imgs/plugin/marketplace           -- the plugin's marketplace icon
 *
 * The first two are a countdown-timer glyph that has nothing to do with this
 * plugin. The last two are ELGATO'S OWN LOGO, which is a trademark problem: it
 * implies Stream Deck ships this plugin. All four should be replaced with
 * original traffic-light artwork (a three-lamp column for the action, a single
 * lamp for the key, a matching glyph for the two plugin icons).
 *
 * They are still here because real PNGs cannot be authored in this repo, and
 * deleting them would break `manifest.json` and fail `streamdeck validate`. Any
 * change to the manifest's `Icon`, `States[].Image`, `CategoryIcon` or top-level
 * `Icon` fields must be made together with the replacement files.
 */

const statusAction = new OpenCodeStatus();
streamDeck.actions.registerAction(statusAction);

function readConfig(): { host: string; port: number } {
  try {
    // Developer escape hatch only: the manifest has no field for environment
    // variables and the Stream Deck app does not reliably pass one through, so
    // this is for local debugging -- never a documented user setting.
    return resolveConfig(process.env);
  } catch (error) {
    streamDeck.logger.error(`Cannot start: ${String(error)}`);
    process.exit(1);
  }
}

const { host, port } = readConfig();

/**
 * Arrival time per instance, stamped with THIS process's clock. The client's
 * `ts` is diagnostics only: trusting a remote clock would keep a client with a
 * wrong clock "fresh" forever.
 */
const lastSeen = new Map<number, number>();

type ParsedState = { instance: number; state: State };

function hasJsonContentType(req: IncomingMessage): boolean {
  // Not `Array.isArray`-guarded: Node joins duplicate `content-type` headers
  // into one comma-separated string, and `set-cookie` is the only header that
  // surfaces as an array. So this is a plain string whenever it is present.
  const value = req.headers['content-type'];

  if (!value) return false;

  // `application/json; charset=utf-8` and friends.
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  if (res.destroyed || res.writableEnded) return;

  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

/**
 * Collects the body, resolving with `null` when it is unusable: too large, or
 * the stream raised an 'error'.
 *
 * Note that a connection going away mid-body does NOT resolve `null` -- see the
 * 'close' handler below for why the partial body is safe to hand back.
 */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    // TCP is a byte stream, and a chunk boundary can fall in the middle of a
    // multi-byte character (a 16-byte body was once seen reassembling as 22
    // corrupted bytes). Decoding each chunk on its own turns those bytes into
    // replacement characters, so hold the incomplete tail back and decode
    // across the boundary.
    const decoder = new StringDecoder('utf8');
    let body = '';
    let tooLarge = false;
    let settled = false;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk: Buffer) => {
      // Keep draining, but stop buffering: the connection stays alive so a real
      // 413 can still be written.
      if (tooLarge) return;

      body += decoder.write(chunk);

      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        tooLarge = true;
        body = '';
      }
    });

    req.on('end', () => finish(tooLarge ? null : body));
    // An aborted request never emits 'end'; without this the promise leaks and
    // the handler waits forever. This resolves the PARTIAL body, not `null`.
    //
    // The ORDINARY way a truncated request arrives is not this branch: the HTTP
    // parser rejects it, the handler IS reached, and `req` emits 'error' with
    // `HPE_INVALID_EOF_STATE` -- which the listener below turns into
    // `finish(null)`, i.e. a 413. Its message blames an oversized body, which is
    // wrong for a truncated one, but this is a rare, local, self-inflicted case
    // and the alternative is the process crashing.
    //
    // So this 'close' branch is a SAFETY NET, not the primary path: it covers
    // the connections that produce neither 'end' nor 'error' -- a reset, a
    // half-closed socket. Handing back the partial text is safe in any case: it
    // is either unparseable (400) or a genuinely complete prefix that
    // `parseState` will refuse. It is never confused with a good payload by
    // accident.
    req.on('close', () => finish(tooLarge ? null : body));
    // A stream 'error' leaves the body untrustworthy, so this one does discard
    // it -- unlike 'close', we do not know how much of it arrived.
    req.on('error', () => finish(null));
  });
}

function parseState(input: unknown): ParsedState | null {
  if (typeof input !== 'object' || input === null) return null;

  const record = input as Record<string, unknown>;
  const instance = record.instance;

  if (typeof instance !== 'number' || !Number.isSafeInteger(instance) || instance < 0) {
    return null;
  }

  if (!isState(record.state)) return null;

  return { instance, state: record.state };
}

async function onState(instance: number, state: State): Promise<boolean> {
  // The pre-check is a cheap rejection on a path that has not yielded yet. It
  // is now a strict pre-check rather than the only defence: `update` reserves
  // its cap slot synchronously, so at most `MAX_TRACKED_INSTANCES` distinct
  // instances are ever in flight at once -- not one more, as it was when this
  // check was the only one. A rejected instance is not recorded at all.
  if (!statusAction.canTrack(instance)) {
    throw new Error(
      `Refusing instance ${instance}: the limit of ${MAX_TRACKED_INSTANCES} tracked instances is reached`,
    );
  }

  // The liveness stamp goes LAST, on the success path only, because `update`
  // can still reject after the pre-check passed (and re-checks `canTrack`
  // itself). A request whose state was never applied is NOT evidence that the
  // client is alive and well, so it must not count as a heartbeat: stamped
  // first, an over-cap client -- one whose every request is answered 503 --
  // would refresh `lastSeen` forever, the sweeper would never see it as
  // stale, its cap slot would never be released, and a new client would stay
  // locked out until some OTHER client happened to go silent first. That
  // deadlock sustained itself; this way it ends on its own STALE_MS after the
  // last state that actually reached the deck.
  const changed = await statusAction.update(instance, state);
  lastSeen.set(instance, Date.now());
  return changed;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Content-Type', 'application/json');

  // An unhandled 'error' on a stream THROWS and takes the whole plugin process
  // down. The OpenCode side aborts after 1500ms, so this is routine, not exotic.
  req.on('error', (error) => {
    streamDeck.logger.debug(`Request stream error: ${String(error)}`);
  });
  res.on('error', (error) => {
    streamDeck.logger.debug(`Response stream error: ${String(error)}`);
  });

  try {
    if (req.method !== 'POST' || req.url !== PATH) {
      respond(res, 404, { error: 'Not found' });
      return;
    }

    // There are no CORS headers, which blocks `application/json` (it triggers a
    // preflight that 404s). `text/plain` and form encoding are CORS-safelisted
    // -- no preflight -- so any page the user visits could drive the key.
    if (!hasJsonContentType(req)) {
      respond(res, 415, { error: 'Content-Type must be application/json' });
      return;
    }

    const body = await readBody(req);

    if (body === null) {
      respond(res, 413, { error: `Body exceeds ${MAX_BODY_BYTES} bytes` });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      respond(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const state = parseState(parsed);
    if (!state) {
      respond(res, 400, { error: 'Expected { instance: non-negative integer, state: green|yellow|red }' });
      return;
    }

    // 503 is retryable: the client's backoff already treats it as a failure.
    const changed = await onState(state.instance, state.state);
    respond(res, 200, { ok: true, state: state.state, changed });
  } catch (error) {
    streamDeck.logger.error(`Could not apply state: ${String(error)}`);
    respond(res, 503, { ok: false, error: String(error) });
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

server.on('clientError', (error, socket) => {
  streamDeck.logger.debug(`Client error: ${String(error)}`);

  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  } else {
    socket.destroy();
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    streamDeck.logger.error(
      `Port ${port} is already in use -- another copy of this plugin (or another process) is holding it. Exiting so Stream Deck reports the failure instead of leaving a permanently deaf, green key.`,
    );
    process.exit(1);
    return;
  }

  streamDeck.logger.error(`HTTP server failed: ${String(error)}`);
});

/**
 * A plugin restart loses `latest`, so keys would stay on their last colour until
 * the next state change. Sweeping silence back to green keeps the key honest.
 */
const sweeper = setInterval(() => {
  const now = Date.now();

  for (const [instance, seen] of [...lastSeen]) {
    if (now - seen <= STALE_MS) continue;

    lastSeen.delete(instance);
    streamDeck.logger.warn(
      `Instance ${instance} has not reported for ${STALE_MS}ms. Treating it as gone and forcing its key to green.`,
    );

    void statusAction.markStale(instance).catch((error) => {
      // `markStale` has already forgotten the state, so a repaint that throws
      // leaves the key showing the last colour with nothing left to retry it:
      // the instance is neither tracked nor forced green, i.e. silently
      // abandoned. Re-arm the entry so a later sweep tries again instead. This
      // cannot pin a cap slot -- `markStale` released it before painting, and
      // the stamp is the sweep's own `now`, so the retry happens one STALE_MS
      // later rather than in a hot loop.
      lastSeen.set(instance, now);
      streamDeck.logger.error(`Could not repaint stale instance ${instance}: ${String(error)}`);
    });
  }
}, SWEEP_MS);

// Never hold the event loop open on our own account.
sweeper.unref();

server.listen(port, host, () => {
  streamDeck.logger.info(`OpenCode status listening on ${host}:${port}`);
});

process.on('SIGTERM', () => {
  clearInterval(sweeper);
  lastSeen.clear();
  server.close();
});

void streamDeck.connect().catch((error: unknown) => {
  streamDeck.logger.error(`Could not connect to Stream Deck: ${String(error)}`);
});
