import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";
import { isValidElevenLabsVoiceId } from "./shared.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider-factory.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("./config-api.js", () => ({
  resolveElevenLabsApiKeyWithProfileFallback: () => null,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async (params: {
    url: string;
    init?: RequestInit;
    timeoutMs?: number;
  }): Promise<{ response: Response; release: () => Promise<void> }> => {
    fetchWithSsrFGuardMock(params);
    return {
      response: await globalThis.fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    };
  },
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

const DIRECTIVE_POLICY = createSpeechDirectivePolicy();

const request = {
  text: "hello",
  cfg: {},
  providerConfig: { apiKey: "xi-test" },
  target: "voice-note" as const,
  timeoutMs: 1_000,
};

describe("elevenlabs speech provider", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn<typeof fetch>();
  const provider = buildElevenLabsSpeechProvider({ formatErrorMessage });

  function sentRequest() {
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = expectDefined(fetchMock.mock.calls[0], "ElevenLabs request");
    if (typeof init?.body !== "string") {
      throw new Error("expected string request body");
    }
    const body: unknown = JSON.parse(init.body);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("expected ElevenLabs request body");
    }
    return { url: new URL(resolveRequestUrl(input)), body };
  }

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    globalThis.fetch = fetchMock;
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchWithSsrFGuardMock.mockClear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["stability", "0", true, { overrides: { voiceSettings: { style: 0.25, stability: 0 } } }],
    ["similarity", "Infinity", true, { warnings: ["invalid similarityBoost value"] }],
    ["speed", "2.01", true, { warnings: ["speed must be between 0.5 and 2"] }],
    ["speed", "invalid", false, {}],
  ] as const)(
    "preserves the %s=%s voice-setting directive",
    (key, value, allowVoiceSettings, expected) => {
      expect(
        provider.parseDirectiveToken?.({
          key,
          value,
          policy: { ...DIRECTIVE_POLICY, allowVoiceSettings },
          currentOverrides: { voiceId: "existing-voice", voiceSettings: { style: 0.25 } },
        }),
      ).toEqual({ handled: true, ...expected });
    },
  );

  it("forwards the core-resolved voice-list timeout", async () => {
    fetchMock.mockResolvedValue(Response.json({ voices: [] }));
    await provider.listVoices?.({ providerConfig: request.providerConfig, timeoutMs: 30_000 });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("rejects blank credentials across discovery and synthesis before requests", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "   ");
    vi.stubEnv("XI_API_KEY", "   ");
    const providerConfig = { apiKey: "   " };
    const blankRequest = { ...request, providerConfig };

    expect(await provider.isConfiguredAsync?.(blankRequest)).toBe(false);
    await expect(
      provider.listVoices?.({ apiKey: "   ", providerConfig, timeoutMs: 1_000 }),
    ).rejects.toThrow("ElevenLabs API key missing");
    for (const synthesize of [
      provider.synthesize,
      provider.streamSynthesize,
      provider.synthesizeTelephony,
    ]) {
      await expect(synthesize?.(blankRequest)).rejects.toThrow("ElevenLabs API key missing");
    }
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("maps deprecated ElevenLabs TTS model IDs in overrides", async () => {
    await provider.synthesizeTelephony?.({
      ...request,
      providerConfig: { apiKey: "xi-test", modelId: "eleven_multilingual_v2" },
      providerOverrides: { modelId: "eleven_turbo_v2_5" },
    });
    expect(sentRequest().body).toHaveProperty("model_id", "eleven_flash_v2_5");
  });

  it("validates ElevenLabs voice ID length and character rules", () => {
    for (const [value, expected] of [
      ["a1b2c3d4e5", true],
      ["a".repeat(40), true],
      ["123456789", false],
      ["a".repeat(41), false],
      ["pMsXgVXv3BLz-gSXRplE", false],
      ["../../../etc/passwd", false],
      ["voice?param=value", false],
    ] as const) {
      expect(isValidElevenLabsVoiceId(value), value).toBe(expected);
    }
  });

  it("drops out-of-range voice settings before synthesis", async () => {
    await provider.synthesizeTelephony?.({
      ...request,
      providerConfig: {
        apiKey: "xi-test",
        voiceSettings: { stability: -1, similarityBoost: 2, style: Number.NaN, speed: 3 },
      },
      providerOverrides: { voiceSettings: { speed: 0.1 } },
    });
    expect(sentRequest().body).toHaveProperty("voice_settings", {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: true,
      speed: 1,
    });
  });

  it("drops malformed latency tier overrides before synthesis", async () => {
    await provider.synthesize({
      ...request,
      target: "audio-file",
      providerOverrides: { latencyTier: 2.5 },
    });
    expect(sentRequest().url.searchParams.has("optimize_streaming_latency")).toBe(false);
  });

  it("returns truthful future-format metadata for a voice-note override", async () => {
    const expected = { outputFormat: "future_123", fileExtension: ".bin", voiceCompatible: false };
    const result = await provider.synthesize({
      ...request,
      providerOverrides: { outputFormat: expected.outputFormat },
    });
    expect(sentRequest().url.searchParams.get("output_format")).toBe(expected.outputFormat);
    expect(result).toEqual({ audioBuffer: Buffer.from([1, 2, 3]), ...expected });
  });

  it("returns truthful stream metadata for an output override and releases the stream once", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          cancel,
        }),
        { headers: { "content-type": "audio/mpeg" } },
      ),
    );
    const result = expectDefined(
      await provider.streamSynthesize?.({
        ...request,
        providerOverrides: { outputFormat: "pcm_44100" },
      }),
      "streamSynthesize result",
    );
    expect(sentRequest().url.searchParams.get("output_format")).toBe("pcm_44100");
    expect(result).toMatchObject({
      outputFormat: "pcm_44100",
      fileExtension: ".pcm",
      voiceCompatible: false,
    });
    const release = expectDefined(result.release, "stream release");
    expect(cancel).not.toHaveBeenCalled();
    await release();
    await release();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
