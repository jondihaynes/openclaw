import { createServer } from "node:http";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";

const { resolveApiKeyMock } = vi.hoisted(() => ({ resolveApiKeyMock: vi.fn() }));

// mock-isolation: Credential fallback is fixture-owned; never read real provider credentials.
vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: resolveApiKeyMock,
}));

import { buildElevenLabsRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const provider = buildElevenLabsRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
});

function resolveConfig(config: Record<string, unknown>) {
  return provider.resolveConfig?.({ cfg: {}, rawConfig: { providers: { elevenlabs: config } } });
}

const sessions: ReturnType<typeof provider.createSession>[] = [];
const committed = { message_type: "committed_transcript", text: "yes" };
const timestamped = { message_type: "committed_transcript_with_timestamps", text: "yes" };
const committedNo = { ...committed, text: "no" };
const timestampedNo = { ...timestamped, text: "no" };
const partial = (text: string) => ({ message_type: "partial_transcript", text });
const deliveryMarker = "transcript frames delivered";

let cleanup: (() => Promise<void>) | undefined;

async function createSession(
  options: {
    onRequest?: (url: URL) => void;
    initialEvent?: Record<string, unknown>;
    events?: readonly Record<string, unknown>[];
    eventsByConnection?: readonly (readonly Record<string, unknown>[])[];
    closeAfterEvents?: boolean;
  } = {},
  sessionOptions: Partial<RealtimeTranscriptionSessionCreateRequest> = {},
) {
  const server = createServer();
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  let connectionCount = 0;
  wss.on("connection", (ws, request) => {
    options.onRequest?.(new URL(request.url ?? "/", "http://127.0.0.1"));
    ws.send(JSON.stringify(options.initialEvent ?? { message_type: "session_started" }));
    const events = options.eventsByConnection?.[connectionCount++] ?? options.events ?? [];
    for (const event of events) {
      ws.send(JSON.stringify(event));
    }
    if (options.closeAfterEvents) {
      ws.close();
    }
  });
  const port = await listenOnLoopback(server);
  cleanup = async () => {
    for (const ws of wss.clients) {
      ws.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  const session = provider.createSession({
    ...sessionOptions,
    providerConfig: {
      apiKey: "fixture-value",
      baseUrl: `http://127.0.0.1:${port}`,
      ...sessionOptions.providerConfig,
    },
  });
  sessions.push(session);
  return session;
}

describe("buildElevenLabsRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.close();
    }
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
    resolveApiKeyMock.mockReset();
  });

  it("normalizes nested provider config", () => {
    expect(
      resolveConfig({
        apiKey: "eleven-key",
        model_id: "scribe_v2_realtime",
        audio_format: "ulaw_8000",
        sample_rate: "8000",
        commit_strategy: "vad",
        language: "en",
      }),
    ).toEqual({
      apiKey: "eleven-key",
      baseUrl: undefined,
      modelId: undefined,
      audioFormat: "ulaw_8000",
      sampleRate: 8000,
      commitStrategy: "vad",
      languageCode: "en",
      vadSilenceThresholdSecs: undefined,
      vadThreshold: undefined,
      minSpeechDurationMs: undefined,
      minSilenceDurationMs: undefined,
    });
  });

  it("connects through the public session boundary with the configured URL params", async () => {
    const requests: URL[] = [];
    const session = await createSession(
      { onRequest: (url) => requests.push(url) },
      {
        providerConfig: {
          modelId: "scribe_v2_realtime",
          audioFormat: "ulaw_8000",
          sampleRate: 8000,
          commitStrategy: "vad",
          languageCode: "en",
        },
      },
    );

    await session.connect();
    session.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/speech-to-text/realtime");
    expect(requests[0]?.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(requests[0]?.searchParams.get("audio_format")).toBe("ulaw_8000");
    expect(requests[0]?.searchParams.get("commit_strategy")).toBe("vad");
    expect(requests[0]?.searchParams.get("language_code")).toBe("en");
  });

  it.each([false, true])(
    "reports provider errors exactly once (pre-ready: %s)",
    async (preReady) => {
      const message = "rate limit exceeded; retry after account reset";
      const event = preReady
        ? { message_type: "rate_limited", error: message }
        : { message_type: "input_error", message };
      const onError = vi.fn();
      const session = await createSession(
        preReady ? { initialEvent: event, closeAfterEvents: true } : { events: [event] },
        { onError },
      );
      if (preReady) {
        await expect(session.connect()).rejects.toThrow(message);
      } else {
        await session.connect();
      }
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message })),
      );
    },
  );

  it.each<[string, (typeof committed)[], string[], string[]]>([
    ["preserves identical adjacent commits", [committed, committed], ["yes", "yes"], []],
    ["consumes one timestamp echo", [committed, timestamped, timestamped], ["yes", "yes"], []],
    ["preserves timestamp-only repeats", [timestamped, timestamped], ["yes", "yes"], []],
    ["preserves differing timestamp text", [committed, timestampedNo], ["yes", "no"], []],
    [
      "preserves delayed echoes across partials",
      [committed, partial("next turn"), timestamped, committed, timestamped],
      ["yes", "yes"],
      ["next turn"],
    ],
    [
      "pairs timestamps with alternating commits",
      [committed, timestamped, committedNo, timestampedNo, committed, timestamped],
      ["yes", "no", "yes"],
      [],
    ],
  ])("%s", async (_name, events, transcripts, partials) => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const session = await createSession(
      { events: [...events, partial(deliveryMarker)] },
      { onError, onPartial, onSpeechStart, onTranscript },
    );

    await session.connect();
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith(deliveryMarker));
    expect(onPartial.mock.calls.map(([text]) => text)).toEqual([...partials, deliveryMarker]);
    expect(onTranscript.mock.calls.map(([text]) => text)).toEqual(transcripts);
    expect(onError).not.toHaveBeenCalled();
    expect(onSpeechStart).not.toHaveBeenCalled();
  });

  it("does not suppress a timestamp-only transcript from a replacement session", async () => {
    const firstMarker = "first session delivered";
    const secondMarker = "replacement session delivered";
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = await createSession(
      {
        eventsByConnection: [
          [committed, partial(firstMarker)],
          [timestamped, partial(secondMarker)],
        ],
      },
      { onPartial, onTranscript },
    );

    await session.connect();
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith(firstMarker));
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("yes");

    await session.connect();
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith(secondMarker));
    expect(onTranscript.mock.calls).toEqual([["yes"], ["yes"]]);
  });

  it("rejects whitespace-only environment keys before session creation", async () => {
    resolveApiKeyMock.mockReturnValue(null);
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.stubEnv("XI_API_KEY", "   ");

    expect(await provider.isConfiguredAsync?.({ cfg: {}, providerConfig: {} })).toBe(false);
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "ElevenLabs API key missing",
    );
  });
});
