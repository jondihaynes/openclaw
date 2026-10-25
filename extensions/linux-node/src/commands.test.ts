import type { CommandOptions, SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import { createLinuxNodeCommands } from "./commands.js";
import type { ResolvedLinuxNodePluginConfig } from "./config.js";

const boundary = vi.hoisted(() => ({
  runCommand: vi.fn<(argv: string[], options: CommandOptions) => Promise<SpawnResult>>(),
  resolveExecutable: vi.fn<typeof import("./executables.js").resolveExecutable>(),
  readdir: vi.fn<() => Promise<string[]>>(),
  readFile: vi.fn<(filePath: string) => Promise<Buffer | string>>(),
  stat: vi.fn<(filePath: string) => Promise<{ size: number }>>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: {
      ...actual,
      readdir: boundary.readdir,
      readFile: boundary.readFile,
      stat: boundary.stat,
    },
  };
});
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandWithTimeout: boundary.runCommand,
}));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  withTempWorkspace: async (_options: unknown, run: (workspace: { dir: string }) => unknown) =>
    await run({ dir: "/tmp" }),
}));
vi.mock("./executables.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./executables.js")>()),
  resolveExecutable: boundary.resolveExecutable,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

const maxMediaRawBytes = Math.floor((25 * 1024 * 1024 - 64 * 1024) / 4) * 3;

const enabledConfig: ResolvedLinuxNodePluginConfig = {
  notify: { enabled: true },
  camera: { enabled: true },
  location: { enabled: true },
};

function success(stdout = ""): SpawnResult {
  return commandResult({ stdout, noOutputTimedOut: false });
}

const jpeg640x480 = Buffer.from("ffd8ffc0000b0801e0028001011100ffd9", "hex");

const runCommand = vi.fn<(argv: string[], options: CommandOptions) => Promise<SpawnResult>>();
let commands: ReturnType<typeof createLinuxNodeCommands>;
function command(name: string) {
  const found = commands.find((entry) => entry.command === name);
  if (!found) {
    throw new Error(`missing command ${name}`);
  }
  return found;
}
async function invoke(name: string, params?: Record<string, unknown>): Promise<unknown> {
  return JSON.parse(await invokeRaw(name, params));
}
function invokeRaw(name: string, params?: Record<string, unknown>) {
  return command(name).handle(JSON.stringify(params));
}
async function expectError(name: string, error: string | Error, params?: Record<string, unknown>) {
  await expect(invokeRaw(name, params)).rejects.toThrow(error);
}
async function expectLocationError(result: SpawnResult, error: string) {
  runCommand.mockResolvedValue(result);
  await expectError("location.get", error);
}

describe("linux-node commands", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    runCommand.mockResolvedValue(success());
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "linux",
    });
    vi.stubEnv("PATH", "/usr/bin");
    vi.setSystemTime(new Date("2026-07-13T12:00:10.000Z"));
    boundary.resolveExecutable.mockImplementation((name) => `/usr/bin/${name}`);
    boundary.readdir.mockResolvedValue(["video0"]);
    boundary.readFile.mockImplementation(async (filePath) =>
      filePath.startsWith("/sys/")
        ? "Test Camera\n"
        : filePath.endsWith(".jpg")
          ? jpeg640x480
          : Buffer.from("mp4"),
    );
    boundary.stat.mockImplementation(async (filePath) => ({
      size: filePath.endsWith(".jpg") ? jpeg640x480.length : 3,
    }));
    boundary.runCommand.mockImplementation(async (argv, options) =>
      argv.includes("-list_formats")
        ? success("[video4linux2,v4l2] Raw : yuyv422 : YUYV 4:2:2")
        : await runCommand(argv, options),
    );
    commands = createLinuxNodeCommands(enabledConfig);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each(["camera.list", "camera.snap", "camera.clip"])(
    "surfaces failed device enumeration for %s without starting FFmpeg",
    async (name) => {
      const error = Object.assign(new Error("device enumeration denied"), { code: "EACCES" });
      boundary.readdir.mockRejectedValueOnce(error);

      await expect(command(name).handle()).rejects.toBe(error);
      expect(boundary.runCommand).not.toHaveBeenCalled();
    },
  );

  it("distinguishes successful empty enumeration from a failed device read", async () => {
    boundary.readdir.mockResolvedValue([]);

    await expect(command("camera.list").handle()).resolves.toBe('{"devices":[]}');
    await expectError("camera.snap", "CAMERA_UNAVAILABLE: no V4L2 camera devices found");
    expect(boundary.runCommand).not.toHaveBeenCalled();
  });

  it("lists only V4L2 nodes that expose capture formats through FFmpeg", async () => {
    boundary.runCommand.mockImplementation(async (argv) =>
      success(
        argv.at(-1) === "/dev/video0"
          ? "[video4linux2,v4l2] Raw : yuyv422 : YUYV 4:2:2"
          : "Not a video capture device",
      ),
    );
    boundary.readdir.mockResolvedValue(["video1", "media0", "video0"]);
    boundary.readFile.mockResolvedValue("Integrated Camera\n");
    await expect(invoke("camera.list")).resolves.toEqual({
      devices: [
        { id: "/dev/video0", name: "Integrated Camera", position: "unknown", deviceType: "v4l2" },
      ],
    });
    expect(boundary.runCommand).toHaveBeenCalledTimes(2);
  });

  it("advertises only enabled Linux capabilities with cached tooling", () => {
    boundary.resolveExecutable.mockImplementation((name) =>
      name === "where-am-i" ? null : `/usr/bin/${name}`,
    );
    const context = {
      config: { plugins: { entries: { "linux-node": { config: enabledConfig } } } },
      env: { PATH: "/usr/bin" },
    };

    expect(command("system.notify").isAvailable?.(context)).toBe(true);
    expect(command("camera.list").isAvailable?.(context)).toBe(true);
    expect(command("location.get").isAvailable?.(context)).toBe(false);

    const disabledCameraContext = structuredClone(context);
    disabledCameraContext.config.plugins.entries["linux-node"].config.camera.enabled = false;
    expect(command("camera.list").isAvailable?.(disabledCameraContext)).toBe(false);

    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    commands = createLinuxNodeCommands(enabledConfig);
    expect(command("system.notify").isAvailable?.(context)).toBe(false);
  });

  it("maps notification priority and ignores sound and delivery", async () => {
    const title = "Build complete";
    const body = "All checks passed";
    const params = { title, body, priority: "timeSensitive", sound: "default", delivery: "system" };
    await expect(invokeRaw("system.notify", params)).resolves.toBe('{"ok":true}');
    expect(runCommand).toHaveBeenCalledWith(
      ["/usr/bin/notify-send", "--urgency", "critical", "--", title, body],
      { timeoutMs: 10_000 },
    );
  });

  it("keeps truncated notification errors within the limit without splitting surrogate pairs", async () => {
    runCommand.mockResolvedValue({
      ...success(),
      code: 1,
      stderr: `${"x".repeat(299)}\u{1f600}tail`,
    });
    await expectError("system.notify", new Error(`NOTIFICATIONS_UNAVAILABLE: ${"x".repeat(299)}`), {
      title: "Test",
    });
  });

  it("accepts either notification field but rejects an empty notification", async () => {
    await expect(invokeRaw("system.notify", { title: "Status", body: "" })).resolves.toBe(
      '{"ok":true}',
    );
    const argv = ["/usr/bin/notify-send", "--urgency", "normal", "--", "Status", ""];
    expect(runCommand.mock.calls[0]?.[0]).toEqual(argv);
    await expectError("system.notify", "INVALID_REQUEST: empty notification", {});
  });

  it("maps snap defaults and clamps delay and quality", async () => {
    const payload = await invoke("camera.snap", {
      deviceId: "/dev/video0",
      delayMs: 50_000,
      quality: 2,
      maxWidth: -1,
      format: "jpeg",
    });
    expect(runCommand.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["10.000", "scale=min(iw\\,1600):-2", "2"]),
    );
    expect(payload).toEqual({
      format: "jpeg",
      base64: jpeg640x480.toString("base64"),
      width: 640,
      height: 480,
    });
  });

  it("records clip audio through PulseAudio and clamps duration", async () => {
    const payload = await invoke("camera.clip", { durationMs: 1 });
    expect(runCommand.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["-f", "pulse", "-i", "default", "-t", "0.250", "-c:a", "aac"]),
    );
    expect(payload).toEqual({
      format: "mp4",
      base64: Buffer.from("mp4").toString("base64"),
      durationMs: 250,
      hasAudio: true,
    });
  });

  it("maps GeoClue accuracy and parses a fresh location payload", async () => {
    const output = `Client object: /org/freedesktop/GeoClue2/Client/1\n\nNew location:\nLatitude:    48.208490°\nLongitude:   16.372080°\nAccuracy:    12.500000 meters\nAltitude:    182.000000 meters\nSpeed:       0.000000 meters/second\nHeading:     270.000000°\nTimestamp:   Mon Jul 13 12:00:00 2026 (1783944000 seconds since the Epoch)\n`;
    runCommand.mockImplementation(async (_argv, options) => {
      options.onOutputChunk?.(Buffer.from(output), "stdout");
      return success(output);
    });
    const payload = await invoke("location.get", {
      timeoutMs: 100,
      maxAgeMs: 20_000,
      desiredAccuracy: "precise",
    });

    expect(runCommand.mock.calls[0]?.[0]).toEqual(["/usr/bin/where-am-i", "-t", "1", "-a", "8"]);
    expect(payload).toEqual({
      lat: 48.20849,
      lon: 16.37208,
      accuracyMeters: 12.5,
      altitudeMeters: 182,
      speedMps: 0,
      headingDeg: 270,
      timestamp: "2026-07-13T12:00:00.000Z",
      isPrecise: true,
      source: "unknown",
    });
  });

  it.each([
    ["stale", "11:00:00", "12:00:05", 20_000],
    ["future-dated", "12:00:15", "12:00:09", 2000],
  ])(
    "keeps GeoClue running past a %s fix until a fresh update arrives",
    async (_kind, rejectedTime, acceptedTime, maxAgeMs) => {
      const fix = (lat: number, time: string) =>
        `\nNew location:\nLatitude: ${lat}\nLongitude: 16\nAccuracy: 25 meters\nTimestamp: now (${Date.parse(`2026-07-13T${time}.000Z`) / 1000} seconds since the Epoch)\n`;
      const rejected = fix(47, rejectedTime);
      const accepted = fix(48, acceptedTime);
      runCommand.mockImplementation(async (_argv, options) => {
        expect(options.onOutputChunk?.(Buffer.from(rejected), "stdout")).toBe(true);
        expect(options.onOutputChunk?.(Buffer.from(accepted), "stdout")).toBe(false);
        return success(`${rejected}${accepted}`);
      });
      expect(await invoke("location.get", { maxAgeMs })).toMatchObject({
        lat: 48,
        timestamp: `2026-07-13T${acceptedTime}.000Z`,
      });
    },
  );

  it("accounts for GeoClue second precision when maxAgeMs is zero", async () => {
    const output = `\nNew location:\nLatitude: 48\nLongitude: 16\nAccuracy: 25 meters\nTimestamp: now (1783944010 seconds since the Epoch)\n`;
    runCommand.mockResolvedValue(success(output));
    vi.setSystemTime(new Date("2026-07-13T12:00:10.900Z"));

    await expect(invokeRaw("location.get", { maxAgeMs: 0 })).resolves.toContain(
      '"timestamp":"2026-07-13T12:00:10.000Z"',
    );
  });

  it("returns stable location timeout and unavailable errors", async () => {
    await expectLocationError(success(""), "LOCATION_TIMEOUT: no fix in time");
    await expectLocationError(
      { ...success(), code: 1, stderr: "GeoClue service unavailable" },
      "LOCATION_UNAVAILABLE: GeoClue service unavailable",
    );
    await expectLocationError(
      success("Geolocation disabled. Quitting..\n"),
      "LOCATION_DISABLED: GeoClue location services are disabled",
    );
    const revokedOutput =
      "New location:\nLatitude: 48\nLongitude: 16\nAccuracy: 25 meters\nAccessDenied: Geolocation disabled for UID 1000\n";
    runCommand.mockImplementation(async (_argv, options) => {
      expect(options.onOutputChunk?.(Buffer.from(revokedOutput), "stdout")).toBe(false);
      return success(revokedOutput);
    });
    await expectError("location.get", "LOCATION_DISABLED: GeoClue location services are disabled");
  });

  it("gates handlers even when invoked without advertisement", async () => {
    commands = createLinuxNodeCommands({
      notify: { enabled: true },
      camera: { enabled: false },
      location: { enabled: false },
    });
    await expectError("camera.list", "CAMERA_DISABLED");
    await expectError("location.get", "LOCATION_DISABLED");
  });

  it("rejects media beyond the 25 MB base64 budget", async () => {
    const readFile = vi.fn(async () => Buffer.alloc(maxMediaRawBytes + 1));
    boundary.stat.mockResolvedValue({ size: maxMediaRawBytes + 1 });
    boundary.readFile.mockImplementation(async (filePath) =>
      filePath.startsWith("/sys/") ? "Test Camera\n" : await readFile(),
    );
    await expectError("camera.clip", "PAYLOAD_TOO_LARGE");
    expect(readFile).not.toHaveBeenCalled();
  });
});
