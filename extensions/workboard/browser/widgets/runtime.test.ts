import "../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getWorkboardState } from "../lib/workboard/runtime.ts";
import { createWorkboardCard } from "../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../lib/workboard/types.ts";
import { workboardTestHost } from "../test/host.setup.ts";
import { createViewContext } from "../test/host.ts";
import { afterWorkboardUpdate as settle } from "../test/settle.ts";
import { createWorkboardWidget } from "../widgets.tsx";
import { acquireWidgetRuntime } from "./runtime.ts";

const statuses = ["ready", "running", "done"] as const;
const cards = statuses.map((status, index) =>
  createWorkboardCard({
    id: status,
    title: `${status.charAt(0).toUpperCase()}${status.slice(1)} card`,
    status,
    position: (index + 1) * 1000,
    metadata: { automation: { boardId: "ops" } },
  }),
);
const movedCard = () => createWorkboardCard({ ...cards[0], status: "running", position: 3000 });
const moveParams = { id: "ready", status: "running", position: 3000 };
const moveError = "Move temporarily unavailable";
const movedTitles = ["Running card", "Ready card"];
const snapshot = (listedCards: WorkboardCard[] = cards) => ({ cards: listedCards, statuses });
const disposers: (() => void)[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

function setup(handler: (method: string, params?: unknown) => unknown = async () => snapshot()) {
  const request = vi.fn(handler);
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  fixture.host.request = request as ControlUiHost["request"];
  const mount = (
    kind: "mini" | "card" | "board",
    props: Record<string, unknown>,
    canMutate = true,
  ) => {
    const abort = new AbortController();
    const scopedRequest = vi.fn((method: string, params?: unknown) => request(method, params));
    const container = document.createElement("div");
    document.body.append(container);
    const context = createViewContext(
      { ...fixture.host, signal: abort.signal, request: scopedRequest as ControlUiHost["request"] },
      { sessionKey: "main", widget: { name: kind, props }, canMutate, canGrant: true },
    );
    const mounted = createWorkboardWidget(fixture.host, kind)(container, context);
    flush();
    const dispose = () => {
      abort.abort();
      mounted?.dispose?.();
    };
    disposers.push(dispose);
    return {
      container,
      scopedRequest,
      signal: abort.signal,
      dispose,
      setPresented: (presented: boolean) => {
        mounted?.update?.({ ...context, presented });
        flush();
      },
    };
  };
  const lease = () => {
    const acquired = acquireWidgetRuntime(fixture.host, () => {});
    disposers.push(() => acquired.release());
    return acquired.runtime;
  };
  const connect = (connected: boolean) => {
    fixture.connection.connected = connected;
    fixture.notify();
  };
  const mountAll = (cardId = "ready", canMutate = true) =>
    [
      mount("card", { cardId }, canMutate),
      mount("mini", {}, canMutate),
      mount("board", {}, canMutate),
    ] as const;
  const moves = (calls = request.mock.calls) =>
    calls.filter(([method]) => method === "workboard.cards.move");
  return { fixture, request, moves, mount, mountAll, lease, connect };
}

type Widget = ReturnType<ReturnType<typeof setup>["mount"]>;
const query = <T extends HTMLElement = HTMLElement>(widget: Widget, selector: string) =>
  widget.container.querySelector<T>(selector);
const select = (widget: Widget) => query<HTMLSelectElement>(widget, "select");
const text = (widget: Widget) => widget.container.textContent;
const texts = (widget: Widget, selector: string) =>
  [...widget.container.querySelectorAll(selector)].map((el) => el.textContent);
function setupMove(move: () => unknown, list: () => unknown = snapshot) {
  return setup(async (method) => (method === "workboard.cards.move" ? move() : list()));
}
const expectLoaded = (widget: Widget) => settle(() => expect(select(widget)).not.toBeNull());
const expectStatus = (widget: Widget, value: string) =>
  settle(() => expect(select(widget)?.value).toBe(value));
function expectText(widgets: readonly Widget[], content: string, present = true) {
  for (const widget of widgets) {
    const assertion = expect(text(widget));
    (present ? assertion : assertion.not).toContain(content);
  }
}
function expectReady(widgets: readonly Widget[], role: "alert" | "status") {
  for (const widget of widgets) {
    expect(text(widget)).toContain("Ready card");
    expect(query(widget, `[role="${role}"]`)).toBeNull();
  }
}
const gesture = (element: Element, type: string) =>
  element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
const startDrag = (widget: Widget) =>
  gesture(expectDefined(query(widget, ".workboard-card"), "draggable card"), "dragstart");

function changeStatus(container: HTMLElement, status = "running") {
  const control = container.querySelector("select")!;
  control.value = status;
  control.dispatchEvent(new Event("change"));
}

it("discloses incomplete widget data and loads an absent card on demand for read-only viewers", async () => {
  const first = expectDefined(cards[0], "first card");
  const cursor = { id: first.id, position: first.position, createdAt: first.createdAt };
  const { request, mountAll } = setup(async (_method, params) => {
    // SAFETY: this fixture receives the cards-list request contract.
    const input = params as { after?: unknown };
    return input.after
      ? snapshot(cards.slice(1))
      : { ...snapshot(cards.slice(0, 1)), nextCursor: cursor };
  });
  const widgets = mountAll("running", false);
  const [card, , board] = widgets;
  await settle(() => {
    expectText(widgets, "Counts and results include loaded cards only");
    expect(text(card)).toContain("This card is not loaded yet");
    expect(text(card)).not.toContain("no longer available");
  });
  query(card, "button")!.click();
  await settle(() => {
    expect(text(card)).toContain("Running card");
    expectText(widgets, "Load more cards", false);
  });
  expect(request).toHaveBeenLastCalledWith("workboard.cards.list", { after: cursor });
  const selects = [...board.container.querySelectorAll("select")];
  expect(selects.map((control) => control.disabled)).toEqual([true, true, true]);
  changeStatus(board.container);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([false, true])("reconnects without stale cards (loaded=%s)", async (previouslyLoaded) => {
  const reconnected = createDeferred<unknown>();
  const { fixture, mountAll, connect, request } = setup(async () => reconnected.promise);
  if (previouslyLoaded) {
    request.mockResolvedValueOnce(snapshot());
  }
  fixture.connection.connected = previouslyLoaded;
  const widgets = mountAll();
  if (previouslyLoaded) {
    await settle(() => expectText(widgets, "Ready card"));
    connect(false);
    flush();
  }

  for (const widget of widgets) {
    expect(query(widget, '[role="status"]')?.textContent).toContain(
      "Connect to the Gateway to load Workboard.",
    );
    expect(text(widget)).not.toContain("no longer available");
    expect(select(widget)).toBeNull();
    expect(query(widget, "[data-test-id]")).toBeNull();
  }

  connect(true);
  flush();
  expectText(widgets, "Loading Workboard");
  reconnected.resolve(snapshot());
  await settle(() => expectReady(widgets, "status"));
});

it("deduplicates moves across widgets while issuing the mutation through the invoking view", async () => {
  const move = createDeferred<unknown>();
  const { mount, moves } = setupMove(() => move.promise);
  const first = mount("card", { cardId: "ready" });
  const second = mount("card", { cardId: "ready" });
  await expectLoaded(second);
  changeStatus(first.container);
  changeStatus(second.container);
  expect(moves()).toHaveLength(1);
  expect(first.scopedRequest).toHaveBeenCalledWith("workboard.cards.move", moveParams);
  expect(second.scopedRequest).not.toHaveBeenCalled();
  move.resolve({ card: movedCard() });
  await expectStatus(second, "running");
});

it.each([
  [false, false, false],
  [false, true, false],
  [false, false, true],
  [false, true, true],
  [true, false, false],
  [true, true, false],
] as const)(
  "move/refresh: success=%s, during=%s, failure=%s",
  async (success, refreshDuringMove, refreshFails) => {
    const refreshed = createDeferred<unknown>();
    const reconciled = createDeferred<unknown>();
    const move = createDeferred<unknown>();
    let persistedCards = cards;
    let listCount = 0;
    const { mountAll, request, lease } = setup(async (method) => {
      if (method === "workboard.cards.move") {
        return move.promise;
      }
      if (method !== "workboard.cards.list") {
        return { tasks: [] };
      }
      const listed = snapshot(persistedCards);
      const count = ++listCount;
      if (success && count > 1) {
        await refreshed.promise;
        return listed;
      }
      return count === 2 ? refreshed.promise : listed;
    });
    const widgets = mountAll();
    const [card, mini, board] = widgets;
    await expectLoaded(card);
    if (!success) {
      // Recovery uses the invoking view's host, not the shared refresh response.
      card.scopedRequest.mockImplementation((method, params) =>
        method === "workboard.cards.list" ? reconciled.promise : request(method, params),
      );
    }
    const runtime = lease();
    let refresh = refreshDuringMove ? null : runtime.refresh();
    changeStatus(card.container);
    refresh ??= runtime.refresh();
    const moved = movedCard();
    persistedCards = success ? [...cards.slice(1), moved] : [moved, ...cards.slice(1)];
    const expectOutcome = () => {
      if (!success) {
        expectText(widgets, moveError);
        expect(select(card)).toBeNull();
        return;
      }
      expect(select(card)?.value).toBe("running");
      expect(texts(mini, ".workboard-widget-mini__card strong")).toEqual(movedTitles);
      expect(texts(board, ".workboard-column--running .workboard-card h3")).toEqual(movedTitles);
    };
    if (success) {
      move.resolve({ card: moved });
      await settle(expectOutcome);
      await settle(() => expect(listCount).toBe(2));
    } else {
      move.reject(new Error(moveError));
      await settle(() =>
        expect(card.scopedRequest).toHaveBeenCalledWith("workboard.cards.list", {}),
      );
      expectText(widgets, moveError);
      expect(getWorkboardState(runtime.owner).mutationReadiness).toBe("canonical_reload_required");
    }
    if (refreshFails) {
      refreshed.reject(new Error("List temporarily unavailable"));
    } else {
      refreshed.resolve(snapshot());
    }
    await refresh;
    if (success) {
      await settle(() => expect(runtime.loading).toBe(false));
      expectOutcome();
      return;
    }
    expectOutcome();
    reconciled.resolve(snapshot(persistedCards));
    await settle(() => expect(getWorkboardState(runtime.owner).mutationReadiness).toBe("ready"));
    expectOutcome();
    query(mini, "button")!.click();
    await settle(() => expectReady(widgets, "alert"));
    expect(select(card)?.value).toBe("running");
    card.scopedRequest.mockResolvedValueOnce({ card: cards[0] });
    changeStatus(card.container, "ready");
    await expectStatus(card, "ready");
  },
);

it.each(["success", "failure", "reconnect"] as const)(
  "refreshes after an older list (%s)",
  async (outcome) => {
    const first = createDeferred<unknown>();
    const current = createDeferred<unknown>();
    const pending = outcome === "reconnect" ? [first.promise, current.promise] : [first.promise];
    const { fixture, mount, connect, request } = setup(
      async () => pending[request.mock.calls.length - 1] ?? snapshot(),
    );
    const mini = mount("mini", {});
    const card = outcome === "reconnect" ? null : mount("card", { cardId: "ready" });
    if (outcome === "reconnect") {
      connect(false);
      connect(true);
    }
    fixture.emit("plugin.workboard.changed", {});
    if (outcome === "failure") {
      first.reject(new Error("List temporarily unavailable"));
    } else {
      first.resolve(snapshot([]));
    }
    if (outcome === "reconnect") {
      await first.promise;
      current.resolve(snapshot([]));
    }
    await settle(() => {
      expect(text(mini)).toContain(outcome === "reconnect" ? "Running card" : "Ready card");
      if (card) {
        expect(text(card)).toContain("Ready card");
      }
    });
  },
);

it("ignores a completed move from the previous connection", async () => {
  const move = createDeferred<unknown>();
  let current = false;
  const { mount, connect } = setupMove(
    () => move.promise,
    () => snapshot(current ? [{ ...cards[0]!, title: "Current card" }] : cards),
  );
  const widget = mount("card", { cardId: "ready" });
  await expectLoaded(widget);
  changeStatus(widget.container);
  connect(false);
  current = true;
  connect(true);
  await settle(() => expect(text(widget)).toContain("Current card"));
  move.resolve({ card: { ...cards[0], title: "Stale card", status: "running" } });
  await move.promise;
  await Promise.resolve();
  expect(text(widget)).toContain("Current card");
  expect(text(widget)).not.toContain("Stale card");
  expect(select(widget)?.value).toBe("ready");
});

it.each([
  { kind: "card", input: "status" },
  { kind: "board", input: "status" },
  { kind: "board", input: "drop" },
] as const)("fences hidden $kind $input with a visible peer", async ({ kind, input }) => {
  const { fixture, request, mount } = setupMove(() => ({ card: movedCard() }));
  const hidden = mount(kind, kind === "card" ? { cardId: "ready" } : { boardId: "ops" });
  const visible = mount("mini", { boardId: "ops" });
  await settle(() => expect(text(visible)).toContain("Ready card"));
  let move = () => changeStatus(hidden.container);
  if (input === "drop") {
    const column = expectDefined(query(hidden, ".workboard-column--running"), "destination column");
    startDrag(hidden);
    move = () => gesture(column, "drop");
  }

  hidden.setPresented(false);
  expect(hidden.signal.aborted).toBe(false);
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(1);
  move();
  expect(hidden.scopedRequest).not.toHaveBeenCalled();
  expect(visible.scopedRequest).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);

  hidden.setPresented(true);
  expect(text(hidden)).toContain("Ready card");
  expect(select(hidden)?.disabled).toBe(false);
  if (input === "drop") {
    // The rejected hidden drop consumes the original drag; start a new gesture.
    startDrag(hidden);
  }
  move();
  expect(hidden.scopedRequest).toHaveBeenCalledExactlyOnceWith("workboard.cards.move", moveParams);
  await settle(() =>
    expect(query<HTMLSelectElement>(hidden, 'select[aria-label="Status: Ready card"]')?.value).toBe(
      "running",
    ),
  );
  hidden.dispose();
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(1);
  visible.dispose();
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
});

it.each(["mini", "board"] as const)("filters %s boards and archives", async (kind) => {
  const extra = (id: string, boardId: string, archivedAt?: number) =>
    createWorkboardCard({ id, title: id, metadata: { automation: { boardId }, archivedAt } });
  const other = extra("Other card", "product");
  const archived = extra("Archived card", "ops", 10);
  const { mount } = setup(async () => snapshot([...cards, other, archived]));
  const scoped = mount(kind, { boardId: "ops" });
  const all = mount(kind, {});
  await settle(() => expect(text(all)).toContain("Other card"));
  expect(text(scoped)).toContain("Ready card");
  expect(text(scoped)).not.toContain("Other card");
  expect(text(all)).not.toContain("Archived card");
  if (kind === "mini") {
    const counts = query(scoped, ".workboard-widget-mini__counts")?.textContent;
    expect(counts?.replace(/\s+/g, " ")).toContain("1 Ready");
    expect(query(scoped, "a")?.getAttribute("href")).toBe("/workboard/ops");
    expect(query(all, "a")?.getAttribute("href")).toBe("/workboard");
  } else {
    const product = mount("board", { boardId: "product" });
    await settle(() => expect(text(product)).toContain("Other card"));
    expect(query(product, ".workboard-column--running")?.textContent).toContain("No cards yet");
    expect(text(product)).not.toContain("No cards match this view");
  }
});

it("skips session-only events, conditionally reloads cards, and fully reloads on reconnect", async () => {
  const revision = { epoch: "cards", revision: 1 };
  const { fixture, lease, connect, request } = setup(async () => ({
    ...snapshot(),
    boards: [],
    revision,
  }));
  const runtime = lease();
  await runtime.refresh();
  request.mockClear();
  fixture.emit("plugin.workboard.changed", { epoch: "cards", revision: 2, cardsRevision: 1 });
  expect(request).not.toHaveBeenCalled();
  await runtime.refresh();
  expect(request).toHaveBeenLastCalledWith("workboard.cards.list", { sinceRevision: revision });
  connect(false);
  connect(true);
  await runtime.refresh();
  expect(request.mock.calls.some(([, params]) => JSON.stringify(params) === "{}")).toBe(true);
});
