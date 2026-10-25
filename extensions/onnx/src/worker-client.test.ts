import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { InferenceWorkerClient } from "./worker-client.js";

const clients: InferenceWorkerClient[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Kill and join blocked work before removing its fixture files.
    await Promise.all(clients.splice(0).map((client) => client.stop()));
    cleanup();
    vi.unstubAllEnvs();
  }),
);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

type FixtureEvent = { kind: string; pid: number; text?: string };

function fixture(options: { holdInit?: boolean } = {}) {
  const dir = tempDirs.make("openclaw-onnx-client-");
  const entry = path.join(dir, "worker.mjs");
  const eventsPath = path.join(dir, "events.jsonl");
  fs.writeFileSync(eventsPath, "");
  fs.writeFileSync(
    entry,
    `
import fs from 'node:fs';
import { join } from 'node:path';
${fixtureReceiptClientSource(receipts.endpoint)}
let eventsPath;
const record = (event) => {
  fs.appendFileSync(eventsPath, JSON.stringify({ ...event, pid: process.pid }) + '\\n');
  if (event.text === 'wait') sendReceipt(eventsPath, 'classify wait');
};
process.on('disconnect', () => process.exit(0));
process.on('message', async (request) => {
  if (request.kind !== 'classify') {
    if (request.kind === 'init') eventsPath = join(request.config.modelDir, 'events.jsonl');
    record({ kind: request.kind });
    if (request.kind === 'init' && ${options.holdInit === true}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    if (request.kind === 'warm') process.send({ kind: 'warmed' });
    return;
  }
  const text = request.inputs[0].text;
  record({ kind: 'classify', text });
  if (text === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  if (text === 'wait') await awaitRelease(eventsPath, 'continue');
  if (text === 'missing') { process.send({ kind: 'error', code: 'model-missing' }); return; }
  if (text === 'exit') process.exit(7);
  const results = request.inputs.map(() => ({ logits: [process.pid, Number(Boolean(process.env.ONNX_CLIENT_TEST_SECRET))], inputTokens: 1 }));
  process.send({ kind: 'results', results });
});
`,
  );
  const config = { modelDir: dir, threads: 1, maxLoadedModels: 1 };
  const client = new InferenceWorkerClient({ workerUrl: pathToFileURL(entry), config });
  clients.push(client);
  const events = (kind?: string): FixtureEvent[] =>
    fs
      .readFileSync(eventsPath, "utf8")
      .split("\n")
      .flatMap((line): FixtureEvent[] => (line ? [JSON.parse(line)] : []))
      .filter((event) => kind === undefined || event.kind === kind);
  const findEvent = (name: string) => {
    const found = events().find((event) => (event.text ?? event.kind) === name);
    if (!found) {
      throw new Error(`Fixture did not reach ${name}`);
    }
    return found;
  };
  return {
    client,
    classify: (text: string, abortSignal = signal(), isAdmissible?: () => boolean) =>
      client.classify("test-model", input(text), abortSignal, isAdmissible),
    events,
    waitFor: (name: string) => vi.waitFor(() => findEvent(name), { timeout: 10_000 }),
    waitHeld: (operation: PromiseLike<unknown>, signal: AbortSignal) =>
      withinTest(
        // Confirm against the durable log even if the operation beats its receipt.
        Promise.race([receipts.waitFor(eventsPath, "classify wait"), operation]).then(() =>
          findEvent("wait"),
        ),
        signal,
      ),
    release: () => receipts.release(eventsPath, "continue"),
  };
}

const input = (text: string) => [{ text, labels: ["yes", "no"], task: "test" }];

const expectDead = (pid: number) =>
  expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));

const signal = () => new AbortController().signal;
const rejectsCode = (operation: Promise<unknown>, code = "runtime") =>
  expect(operation).rejects.toMatchObject({ code });

it.for([
  [input("x".repeat(262145))[0]!],
  Array.from({ length: 8 }, () => input("x".repeat(150000))[0]!),
])("rejects oversized input before starting a worker and remains usable", async (inputs) => {
  const { client, classify, events } = fixture();
  await rejectsCode(client.classify("test-model", inputs, signal()), "unsupported-input");
  expect(events()).toEqual([]);
  await expect(classify("valid")).resolves.toHaveLength(1);
});

it("reuses a warm process, preserves known model errors, and excludes inherited credentials", async () => {
  vi.stubEnv("ONNX_CLIENT_TEST_SECRET", "synthetic");
  const { client, classify } = fixture();
  await client.warm(["test-model"], signal());
  const first = await classify("first");
  await rejectsCode(classify("missing"), "model-missing");
  const second = await classify("second");
  expect(first).toEqual(second);
  expect(first[0]?.logits[1]).toBe(0);
  const pid = first[0]!.logits[0]!;
  await client.stop();
  expectDead(pid);
});

it.for(["cancel", "closed", "throws"] as const)(
  "preserves FIFO after queued %s",
  async (mode, ctx) => {
    const { classify, events, waitHeld, release } = fixture();
    const active = classify("wait");
    void active.catch(() => {});
    const started = await waitHeld(active, ctx.signal);
    const canceled = new AbortController();
    let admitted = true;
    const reason = new Error("queued rejected");
    const queued = classify(
      "rejected",
      canceled.signal,
      mode === "cancel"
        ? undefined
        : () => {
            if (!admitted && mode === "throws") {
              throw reason;
            }
            return admitted;
          },
    );
    const rejected = mode === "closed" ? rejectsCode(queued) : expect(queued).rejects.toBe(reason);
    const survivors = [classify("second"), classify("third")];
    const order = ["wait", "second", "third"];
    await rejectsCode(classify("overflow"));
    admitted = false;
    if (mode === "cancel") {
      canceled.abort(reason);
      await rejected;
      survivors.push(classify("fourth"));
      order.push("fourth");
    }
    expect(() => process.kill(started.pid, 0)).not.toThrow();
    release();
    await Promise.all([active, rejected, ...survivors]);
    expect(events("classify")).toMatchObject(order.map((text) => ({ text, pid: started.pid })));
  },
);

it.each(["cancel", "exit"])("joins %s before recovery", async (mode) => {
  const { classify, waitFor } = fixture();
  const controller = new AbortController();
  const text = mode === "cancel" ? "block" : "exit";
  const active = classify(text, controller.signal);
  const rejected =
    mode === "cancel" ? expect(active).rejects.toThrow("active canceled") : rejectsCode(active);
  const queued = classify("survivor");
  const started = await waitFor(text);
  if (mode === "cancel") {
    controller.abort(new Error("active canceled"));
  }
  await rejected;
  expectDead(started.pid);
  const result = await queued;
  expect(result[0]?.logits[0]).not.toBe(started.pid);
});

it.each([false, true])("joins stop and rejects new work (init=%s)", async (holdInit) => {
  const { client, classify, waitFor } = fixture({ holdInit });
  const activeRejected = rejectsCode(classify("block"));
  const started = await waitFor(holdInit ? "init" : "block");
  const queued = client.warm(["test-model"], signal());
  const queuedRejected = rejectsCode(queued);
  await Promise.all([client.stop(), client.stop(), activeRejected, queuedRejected]);
  expectDead(started.pid);
  await rejectsCode(classify("late"));
});
