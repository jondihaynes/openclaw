// Local Gateway proof: a terminal workboard_move frees the owner's slot.
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
        notifications: card.metadata?.notifications?.map((entry) => entry.kind),
      }
    : null;
}

describe("workboard terminal move proof", () => {
  it("frees the owner slot after workboard_move to done", { timeout: 180_000 }, async () => {
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
      ((await call("workboard.cards.list", { boardId: "proof" })) as { cards: Card[] }).cards.find(
        (entry) => entry.id === id,
      );

    await call("workboard.boards.upsert", { id: "proof" });
    const first = (
      (await call("workboard.cards.create", {
        title: "First card",
        status: "ready",
        agentId: "qa",
        boardId: "proof",
      })) as { card: Card }
    ).card;
    const dispatched = (await call("workboard.cards.dispatch", {
      boardId: "proof",
    })) as DispatchResult;
    log("dispatch 1", { started: dispatched.started.length, failures: dispatched.startFailures });
    expect(dispatched.started).toEqual([expect.objectContaining({ cardId: first.id })]);
    const terminal = (await call(
      "agent.wait",
      { runId: dispatched.started[0]!.runId, timeoutMs: 60_000 },
      { timeoutMs: 65_000 },
    )) as { status?: unknown };
    log("worker run", { status: terminal.status });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    log("first card after worker run", summarize(await readCard(first.id)));

    const second = (
      (await call("workboard.cards.create", {
        title: "Second card",
        status: "ready",
        agentId: "qa",
        boardId: "proof",
      })) as { card: Card }
    ).card;
    const blockedDispatch = (await call("workboard.cards.dispatch", {
      boardId: "proof",
    })) as DispatchResult;
    log("dispatch 2 before move", {
      started: blockedDispatch.started.map((entry) => entry.cardId === second.id),
      failures: blockedDispatch.startFailures.map((entry) => entry.error),
    });

    const foreign = await call("tools.invoke", {
      name: "workboard_move",
      agentId: "main",
      args: { id: first.id, status: "done" },
    });
    log("workboard_move as another owner", foreign);
    log("first card after rejected move", summarize(await readCard(first.id)));

    const moved = await call("tools.invoke", {
      name: "workboard_move",
      agentId: "qa",
      args: { id: first.id, status: "done" },
    });
    log("workboard_move as owner", { ok: (moved as { ok?: boolean }).ok });
    const finished = await readCard(first.id);
    log("first card after move", summarize(finished));

    const nextDispatch = (await call("workboard.cards.dispatch", {
      boardId: "proof",
    })) as DispatchResult;
    log("dispatch 3 after move", {
      startedSecondCard: nextDispatch.started.some((entry) => entry.cardId === second.id),
      failures: nextDispatch.startFailures.map((entry) => entry.error),
    });

    expect((foreign as { ok?: boolean }).ok).toBe(false);
    expect(finished?.metadata?.claim).toBeUndefined();
    expect(nextDispatch.started).toEqual([expect.objectContaining({ cardId: second.id })]);
  });
});
