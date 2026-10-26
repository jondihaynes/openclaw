// Local Gateway proof: workboard_move to done/blocked while the worker run is still running.
// The mock provider holds the first response for ~8s for the "stalled turn recovery qa check"
// prompt, so the card is moved while its execution and attempt are still running.
import { afterEach, describe, expect, it } from "vitest";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type Card = {
  id: string;
  status?: string;
  execution?: { status?: string };
  metadata?: {
    claim?: { ownerId?: string };
    attempts?: Array<{ status?: string }>;
    failureCount?: number;
    notifications?: Array<{ kind?: string }>;
  };
};
type DispatchResult = {
  started: Array<{ cardId: string; runId: string }>;
  startFailures: Array<{ cardId: string; error: string }>;
};

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;

afterEach(async () => {
  if (gatewayOwner) {
    await stopQaGatewayFixture(gatewayOwner);
  }
  gatewayOwner = undefined;
});

function log(label: string, value: unknown) {
  console.log(`[proof] ${label}: ${JSON.stringify(value)}`);
}

function summarize(card: Card | undefined) {
  return card
    ? {
        status: card.status,
        execution: card.execution?.status,
        claimOwner: card.metadata?.claim?.ownerId ?? null,
        attempts: card.metadata?.attempts?.map((attempt) => attempt.status),
        failureCount: card.metadata?.failureCount ?? 0,
        notifications: card.metadata?.notifications?.map((entry) => entry.kind) ?? [],
      }
    : null;
}

describe("workboard active-run terminal move proof", () => {
  it.each(["done", "blocked"] as const)(
    "settles a running card moved to %s and frees the owner",
    { timeout: 240_000 },
    async (target) => {
      gatewayOwner = createQaLiveLaneGateway();
      const harness = await gatewayOwner.start({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna",
        transport: { requiredPluginIds: [], createGatewayConfig: () => ({}) },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig: (config) => ({
          ...config,
          plugins: {
            ...config.plugins,
            allow: [...new Set([...(config.plugins?.allow ?? []), "workboard"])],
            entries: { ...config.plugins?.entries, workboard: { enabled: true } },
          },
        }),
      });
      const call = (method: string, params: unknown, opts?: { timeoutMs: number }) =>
        harness.gateway.call(method, params, opts);
      const readCard = async (id: string) =>
        (
          (await call("workboard.cards.list", { boardId: "proof" })) as { cards: Card[] }
        ).cards.find((entry) => entry.id === id);
      const create = async (title: string) =>
        (
          (await call("workboard.cards.create", {
            title,
            status: "ready",
            agentId: "qa",
            boardId: "proof",
          })) as { card: Card }
        ).card;

      log("target status", target);
      await call("workboard.boards.upsert", { id: "proof" });
      const first = await create("stalled turn recovery qa check");
      const dispatched = (await call("workboard.cards.dispatch", {
        boardId: "proof",
      })) as DispatchResult;
      expect(dispatched.started).toEqual([expect.objectContaining({ cardId: first.id })]);
      const running = await readCard(first.id);
      log("first card while worker runs", summarize(running));

      const second = await create("Second card");
      const blockedDispatch = (await call("workboard.cards.dispatch", {
        boardId: "proof",
      })) as DispatchResult;
      log("dispatch 2 before move", {
        startedSecondCard: blockedDispatch.started.some((entry) => entry.cardId === second.id),
      });

      const foreign = (await call("tools.invoke", {
        name: "workboard_move",
        agentId: "main",
        args: { id: first.id, status: target },
      })) as { ok?: boolean };
      log("workboard_move as another owner", { ok: foreign.ok });
      log("first card after rejected move", summarize(await readCard(first.id)));

      const moved = (await call("tools.invoke", {
        name: "workboard_move",
        agentId: "qa",
        args: { id: first.id, status: target },
      })) as { ok?: boolean };
      log("workboard_move as owner", { ok: moved.ok });
      const finished = await readCard(first.id);
      log("first card after move", summarize(finished));

      const nextDispatch = (await call("workboard.cards.dispatch", {
        boardId: "proof",
      })) as DispatchResult;
      log("dispatch 3 after move", {
        startedSecondCard: nextDispatch.started.some((entry) => entry.cardId === second.id),
      });

      // Let the held worker run end, then confirm its late lifecycle sync does not reopen the card.
      const terminal = (await call(
        "agent.wait",
        { runId: dispatched.started[0]!.runId, timeoutMs: 120_000 },
        { timeoutMs: 125_000 },
      )) as { status?: unknown };
      log("held worker run", { status: terminal.status });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      log("first card after worker run ended", summarize(await readCard(first.id)));

      expect(running?.execution?.status).toBe("running");
      expect(foreign.ok).toBe(false);
      expect(moved.ok).toBe(true);
      expect(finished?.metadata?.claim).toBeUndefined();
      expect(finished?.execution?.status).toBe(target);
      expect(nextDispatch.started).toEqual([expect.objectContaining({ cardId: second.id })]);
    },
  );
});
