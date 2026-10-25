import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { buildDeepgramRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";

const provider = buildDeepgramRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
});

let cleanup: (() => Promise<void>) | undefined;

async function createDeepgramRealtimeServer(onConnection?: (ws: WebSocket) => void) {
  const requests: Array<{ url: URL; headers: Record<string, string | string[] | undefined> }> = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 * 1024 });
  wss.on("connection", (ws, request) => {
    requests.push({
      url: new URL(request.url ?? "/", "http://127.0.0.1"),
      headers: request.headers,
    });
    onConnection?.(ws);
  });
  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });
  cleanup = () =>
    new Promise<void>((resolve) => {
      wss.clients.forEach((ws) => ws.terminate());
      wss.close(() => resolve());
    });
  return {
    baseUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}/deepgram/v1`,
    requests,
  };
}

function sendResult(ws: WebSocket, text: string, ...flags: Array<"final" | "speech" | "finalize">) {
  ws.send(
    JSON.stringify({
      type: "Results",
      channel: { alternatives: [{ transcript: text }] },
      is_final: flags.includes("final"),
      speech_final: flags.includes("speech"),
      from_finalize: flags.includes("finalize"),
    }),
  );
}

function parseClientMessage(data: RawData): Record<string, unknown> {
  return JSON.parse(rawDataToString(data, "utf8")) as Record<string, unknown>;
}

async function createScenario(onConnection: (ws: WebSocket) => void, endpointingMs?: number) {
  const { baseUrl, requests } = await createDeepgramRealtimeServer(onConnection);
  const callbacks = {
    onPartial: vi.fn(),
    onTranscript: vi.fn(),
    onSpeechStart: vi.fn(),
    onError: vi.fn<(error: Error) => void>(),
  };
  const session = provider.createSession({
    providerConfig: { apiKey: "dummy", baseUrl, endpointingMs },
    ...callbacks,
  });
  try {
    await session.connect();
  } catch (error) {
    session.close();
    throw error;
  }
  return {
    ...callbacks,
    session,
    requests,
    [Symbol.dispose]: () => session.close(),
    waitForDelivery: () =>
      vi.waitFor(() => {
        expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: "frames delivered" }),
        );
      }),
  };
}

function sendDeliveryMarker(ws: WebSocket) {
  // Observe delivery without creating another speech turn.
  ws.send(JSON.stringify({ type: "Error", message: "frames delivered" }));
}

async function createFinalizationScenario(reply: boolean) {
  const onFinalize = vi.fn();
  const scenario = await createScenario((ws) => {
    sendResult(ws, "good", "final");
    sendResult(ws, "bye");
    ws.on("message", (data) => {
      if (parseClientMessage(data).type !== "Finalize") {
        return;
      }
      onFinalize();
      if (reply) {
        sendResult(ws, "bye", "final", "finalize");
      }
    });
  }, 10_000);
  return { ...scenario, onFinalize };
}

describe("buildDeepgramRealtimeTranscriptionProvider", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it("normalizes nested config and connects through an explicit HTTP base URL", async () => {
    const server = await createDeepgramRealtimeServer();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          deepgram: {
            apiKey: "dg-key",
            baseUrl: server.baseUrl,
            model: "nova-3",
            encoding: "g711_ulaw",
            sample_rate: "8000",
            interim_results: "true",
            endpointing: "500",
            language: "en-US",
          },
        },
      },
    });

    const session = provider.createSession({ providerConfig: resolved ?? {} });
    await session.connect();
    session.close();
    expect(server.requests).toHaveLength(1);
    const { url, headers } = server.requests[0]!;
    expect(url.pathname).toBe("/deepgram/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: "nova-3",
      encoding: "mulaw",
      sample_rate: "8000",
      channels: "1",
      interim_results: "true",
      endpointing: "500",
      language: "en-US",
    });
    expect(headers.authorization).toBe("Token dg-key");
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("DEEPGRAM_API_KEY", "");
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(
      "Deepgram API key missing",
    );
  });

  it("validates the environment override", () => {
    vi.stubEnv("DEEPGRAM_BASE_URL", "not a url");
    expect(() => provider.createSession({ providerConfig: { apiKey: "dg-key" } })).toThrow(
      "Invalid Deepgram baseUrl: value is not a valid URL",
    );
  });

  it("does not echo the configured URL in validation errors", () => {
    const rawMarker = "configured-value-marker";
    const nonHttp = `ftp://files.example.com/${rawMarker}`;
    try {
      provider.createSession({ providerConfig: { apiKey: "dg-key", baseUrl: nonHttp } });
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/^Invalid Deepgram baseUrl: unsupported scheme/);
      expect(message).not.toContain(rawMarker);
    }
  });

  it("does not promote a rejected provisional tail on an empty speech-final result", async () => {
    using scenario = await createScenario((ws) => {
      sendResult(ws, "delete everything");
      sendResult(ws, "", "final", "speech");
      ws.send(JSON.stringify({ type: "SpeechStarted" }));
      sendDeliveryMarker(ws);
    });
    const { session, onPartial, onSpeechStart, onTranscript } = scenario;
    await scenario.waitForDelivery();
    expect(scenario.requests[0]?.url.searchParams.get("endpointing")).toBe("800");
    expect(scenario.requests[0]?.url.searchParams.get("model")).toBe("nova-3");
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    session.close();

    expect(onPartial).toHaveBeenCalledWith("delete everything");
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("preserves identical transcripts from consecutive utterances", async () => {
    using scenario = await createScenario((ws) => {
      sendResult(ws, "yes", "final", "speech");
      sendResult(ws, "yes", "final", "speech");
      sendDeliveryMarker(ws);
    });
    await scenario.waitForDelivery();
    scenario.session.close();
    expect(scenario.onTranscript.mock.calls).toEqual([["yes"], ["yes"]]);
  });

  it("flushes finalized text returned after a client finalize request", async () => {
    using scenario = await createFinalizationScenario(true);
    const { session, onTranscript } = scenario;
    session.close();
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledExactlyOnceWith("good bye"));
  });

  it("flushes finalized text once when finalize produces no result", async () => {
    using scenario = await createFinalizationScenario(false);
    const { session, onPartial, onTranscript } = scenario;

    try {
      await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("good bye"));
      vi.useFakeTimers();
      session.close();
      session.close();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(scenario.onFinalize).toHaveBeenCalledTimes(1);
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("good");
    } finally {
      if (vi.isFakeTimers()) {
        session.close();
      } else {
        // A failed observation can leave finalized text; close must own its fallback clock.
        vi.useFakeTimers();
        session.close();
        await vi.advanceTimersByTimeAsync(5_000).catch(() => undefined);
      }
    }
  });

  it("does not commit a turn on an utterance-end gap before speech-final", async () => {
    using scenario = await createScenario((ws) => {
      sendResult(ws, "still", "final");
      ws.send(JSON.stringify({ type: "UtteranceEnd" }));
      sendResult(ws, "speaking", "final", "speech");
    }, 25);
    const { session, onPartial, onTranscript } = scenario;
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("still speaking"));
    session.close();
    expect(onPartial).toHaveBeenCalledWith("still");
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("does not infer silence from a gap between provisional results", async () => {
    vi.useFakeTimers();
    let socket: WebSocket | undefined;
    using scenario = await createScenario((ws) => {
      socket = ws;
      sendResult(ws, "still speaking");
    }, 25);
    const { session, onPartial, onTranscript } = scenario;
    await vi.waitFor(() => expect(onPartial).toHaveBeenCalledWith("still speaking"));
    await vi.advanceTimersByTimeAsync(350);
    expect(onTranscript).not.toHaveBeenCalled();
    sendResult(socket!, "continuous speech", "final", "speech");
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("continuous speech"));
    session.close();
    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "discards provisional speech", isFinal: false, expected: [["new"]] },
    {
      name: "preserves finalized speech as a separate turn",
      isFinal: true,
      expected: [["old"], ["new"]],
    },
  ])("$name when the provider reconnects", async ({ isFinal, expected }) => {
    vi.useFakeTimers();
    let connectionCount = 0;
    using scenario = await createScenario((ws) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        sendResult(ws, "old", ...(isFinal ? ["final" as const] : []));
        ws.close();
        return;
      }
      sendResult(ws, "new", "final", "speech");
    }, 10_000);
    const { session, onTranscript } = scenario;
    // Observe the real socket close before advancing the provider's retry delay.
    await vi.waitFor(() => expect(session.isConnected()).toBe(false));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledTimes(expected.length), {
      timeout: 3000,
    });
    session.close();
    expect(onTranscript.mock.calls).toEqual(expected);
  });

  it("terminates instead of retaining an oversized utterance", async () => {
    using scenario = await createScenario((ws) => {
      sendResult(ws, "x".repeat(256 * 1024), "final");
      sendResult(ws, "y");
    });
    const { session, onError } = scenario;
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("retained transcript exceeded"),
        }),
      ),
    );
    expect(session.isConnected()).toBe(false);
  });
});
