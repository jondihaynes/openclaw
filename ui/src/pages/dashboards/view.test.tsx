/* @vitest-environment jsdom */

import { createMemo, createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createFrameQueue } from "../../test-helpers/animation-frame-queue.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DashboardsView, type DashboardGalleryFilters, type DashboardsRouteData } from "./view.tsx";

const filters: DashboardGalleryFilters = { query: "", ownerId: "", sort: "updated" };
const handlers = { onFilterChange: vi.fn() };

const dashboard = {
  key: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
  kind: "direct",
  boardFace: "chat",
  displayName: "Deploy monitor",
  updatedAt: 2,
} satisfies SessionsListResult["sessions"][number];

function click(options: MouseEventInit = {}) {
  return new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
}

function routeData(sessions: SessionsListResult["sessions"], basePath = ""): DashboardsRouteData {
  return {
    result: sessionsResult(sessions),
    error: null,
    basePath,
    fallbackAgentId: "main",
    mainKey: "main",
    globalScope: false,
  };
}

it("keeps card text, links and arrows while deferring previews until native focus", async () => {
  const { request } = createFrameQueue();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(request);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  onTestFinished(() => vi.restoreAllMocks());
  const view = mountSolid(() => (
    <DashboardsView
      data={routeData([
        { ...dashboard, createdActor: { type: "human", id: "mira", label: "Mira" } },
      ])}
      readReady={() => undefined}
      filters={filters}
      handlers={handlers}
    />
  ));
  onTestFinished(() => view.unmount());
  const card = view.container.querySelector<HTMLElement>("[data-dashboard-session]")!;
  const link = card.querySelector<HTMLAnchorElement>("a")!;
  expect(card.querySelector("h2")?.textContent).toBe("Deploy monitor");
  expect(link.getAttribute("href")).toContain("/dashboard/main/deploy-monitor-");
  expect(card.querySelector("openclaw-dashboard-preview")).toBeNull();
  expect(card.querySelector(".dashboard-card__author")?.textContent).toContain("By Mira");
  expect(card.querySelector(".dashboard-card__footer")?.textContent).toContain("Updated");
  expect(card.querySelector(".dashboard-card__open")).not.toBeNull();
  expect(card.querySelector(".dashboard-card__open svg")).not.toBeNull();

  link.focus();
  flush();
  await waitForSolid(() => {
    expect(card.querySelector("openclaw-dashboard-preview")).not.toBeNull();
    expect(card.querySelector(".dashboard-card__author")?.textContent).toContain("By Mira");
    expect(card.querySelector(".dashboard-card__open svg")).not.toBeNull();
    expect(card.querySelector("a")).toBe(link);
    expect(document.activeElement).toBe(link);
  });
});

it.each([
  ["gallery", "[data-dashboard-session]", "Release health"],
  ["empty", "[data-dashboards-empty]", "No dashboards yet"],
  ["error", '[role="alert"]', "Dashboard service unavailable"],
])("resolves the accessible dashboard skeleton to %s", async (outcome, selector, message) => {
  const [value, setValue] = createSignal<DashboardsRouteData>();
  const pending = Promise.withResolvers<void>();
  const { container } = mountSolid(() => {
    const ready = createMemo(() => pending.promise);
    return (
      <DashboardsView data={value()} readReady={ready} filters={filters} handlers={handlers} />
    );
  });

  const busy = container.querySelector('[aria-busy="true"]');
  expect(busy).not.toBeNull();
  const placeholders = busy?.querySelectorAll(".skeleton") ?? [];
  expect(placeholders.length).toBeGreaterThan(0);
  expect(busy?.querySelector(".dashboards-toolbar")).not.toBeNull();
  expect(busy?.querySelectorAll(".dashboards-grid .dashboard-preview").length).toBeGreaterThan(0);
  for (const placeholder of placeholders) {
    expect(placeholder.closest('[aria-hidden="true"]')).not.toBeNull();
  }
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");
  expect(busy?.querySelectorAll("a, button, input, select, textarea").length).toBe(0);

  const data = routeData(
    outcome === "gallery"
      ? [{ key: "agent:main:dashboard:release", kind: "direct", displayName: "Release health" }]
      : [],
  );
  if (outcome === "error") {
    data.result = null;
    data.error = "Dashboard service unavailable";
  }
  setValue(data);
  if (outcome === "error") {
    pending.reject(new Error(data.error!));
  } else {
    pending.resolve();
  }

  await waitForSolid(() => {
    expect(container.querySelector('[aria-busy="true"], .skeleton')).toBeNull();
    expect(container.querySelector(selector)?.textContent).toContain(message);
  });
  if (outcome === "empty") {
    expect(container.querySelector(selector)?.textContent).toContain(
      "Dashboards created in your tasks will appear here",
    );
  }
  if (outcome === "error") {
    expect(container.querySelector("[data-dashboards-empty]")).toBeNull();
  }
});

it.each(["", "/openclaw"])("navigates dashboard links with base path %s", (basePath) => {
  const onNavigate = vi.fn();
  const { container } = mountSolid(() => (
    <DashboardsView
      data={routeData([dashboard], basePath)}
      readReady={() => undefined}
      filters={filters}
      handlers={{ ...handlers, onNavigate }}
    />
  ));

  const row = container.querySelector<HTMLElement>("[data-dashboard-session]");
  expect(row?.textContent).toContain("Deploy monitor");
  const link = row!.querySelector<HTMLAnchorElement>(".dashboard-card__main")!;
  const pathname = `${basePath}/dashboard/main/deploy-monitor-1234567890abcdef1234567890abcdef`;
  expect(link.getAttribute("href")).toBe(pathname);
  let intercepted = false;
  container.addEventListener("click", (event) => {
    intercepted = event.defaultPrevented;
    // Observe the card's routing decision without navigating the jsdom document.
    event.preventDefault();
  });
  link.dispatchEvent(click());
  expect(intercepted).toBe(true);
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("dashboard", {
    pathname,
    search: "?__openclawSessionKey=agent%3Amain%3Adashboard%3A12345678-90ab-cdef-1234-567890abcdef",
  });

  for (const activation of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    link.dispatchEvent(click(activation));
    expect(intercepted).toBe(false);
  }
  const handled = click();
  handled.preventDefault();
  link.dispatchEvent(handled);
  expect(onNavigate).toHaveBeenCalledOnce();
});
