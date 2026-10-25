/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalHistoryResult } from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import type {
  ExecApprovalGrantsListResult,
  ExecApprovalStandingGrant,
} from "../../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ApprovalsPage } from "./approvals-page.tsx";

const historyTable = ".approval-history-table";
const grantsTable = ".standing-grants-table";
const oldAutomation = "Old Gateway automation";
const currentAutomation = "Current Gateway automation";
function operatorAuth(scopes?: string[], recoveryScope?: string) {
  return { role: "operator", scopes, recoveryScope };
}
const grantReply = (name: string) => ({ grants: [standingGrant(name)] });
const emptyHistory = () => Promise.resolve({ items: [] });
const historyReply = (id: string, time: number, nextCursor?: string) => ({
  items: [terminal(id, time)],
  ...(nextCursor ? { nextCursor } : {}),
});

function expectButton(button: HTMLButtonElement, disabled: boolean, text: string) {
  expect(button.disabled).toBe(disabled);
  expect(button.textContent).toContain(text);
}

function replyOnce(...values: unknown[]) {
  const request = vi.fn();
  for (const value of values) {
    request.mockResolvedValueOnce(value);
  }
  return request;
}

function terminal(id: string, resolvedAtMs: number): ApprovalHistoryResult["items"][number] {
  return {
    id,
    status: "denied",
    presentation: { kind: "exec", commandText: `echo ${id}`, allowedDecisions: ["deny"] },
    urlPath: `/approve/${id}`,
    createdAtMs: resolvedAtMs - 1_000,
    expiresAtMs: resolvedAtMs + 60_000,
    resolvedAtMs,
    decision: "deny",
    reason: "user",
    source: { agentId: "main", sessionKey: "agent:main:test" },
    resolver: { kind: "device", id: "reviewer-device" },
  };
}

function createPage(
  history: (method: string, params?: unknown) => unknown = emptyHistory,
  auth?: { role: string; scopes?: string[]; recoveryScope?: string },
  grants: () => unknown = () => Promise.resolve({ grants: [] }),
  revoke?: () => unknown,
) {
  const request = vi.fn((method: string, params?: unknown) =>
    method === "exec.approval.grants.list"
      ? grants()
      : method === "exec.approval.grants.revoke" && revoke
        ? revoke()
        : history(method, params),
  );
  const client = createTestGatewayClient(request);
  const initialGateway = createApplicationGateway({
    phase: "connected",
    client,
    ...(auth ? { hello: { auth } } : {}),
  } as ApplicationGatewaySnapshot);
  let currentGateway = initialGateway;
  const context = {
    basePath: "",
    gateway: currentGateway.gateway,
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const { container: page } = mountSolid(() => <ApprovalsPage />, { wrapper: provider.wrapper });
  const updateGateway = (next: Partial<ApplicationGatewaySnapshot>) => {
    currentGateway.publish({ ...currentGateway.gateway.snapshot, ...next });
    flush();
  };
  const query = <T extends HTMLElement = HTMLElement>(selector: string) =>
    page.querySelector<T>(selector);
  const text = (selector: string) => query(selector)?.textContent;
  const waitText = (selector: string, value: string) =>
    waitForSolid(() => expect(text(selector)).toContain(value));
  flush();
  return {
    page,
    query,
    text,
    history: () => text(historyTable),
    grants: () => text(grantsTable),
    button: () => query<HTMLButtonElement>(`${grantsTable} button`),
    waitHistory: (value: string) => waitText(historyTable, value),
    waitGrants: (value: string) => waitText(grantsTable, value),
    waitError: (value: string) => waitText('[role="alert"]', value),
    request,
    updateGateway,
    replaceGateway(this: void, kind: "source" | "client" | "account" | "recovery scope") {
      if (kind === "source") {
        currentGateway = createApplicationGateway(currentGateway.gateway.snapshot);
        provider.setContext({ ...context, gateway: currentGateway.gateway });
      } else if (kind === "client") {
        updateGateway({ client: createTestGatewayClient(request) });
      } else if (kind === "account") {
        updateGateway({ selfUser: { id: "second" } });
      } else {
        updateGateway({ hello: operatorHello(undefined, "scope-second") });
      }
      flush();
    },
    resolveApproval(this: void, id = "refreshed") {
      initialGateway.publishEvent({
        event: "exec.approval.resolved",
        payload: { id, decision: "deny" },
        type: "event",
      } as GatewayEventFrame);
    },
  };
}

beforeEach(() => i18n.setLocale("en"));

function operatorHello(
  scopes?: string[],
  recoveryScope?: string,
): ApplicationGatewaySnapshot["hello"] {
  return {
    auth: operatorAuth(scopes, recoveryScope),
  } as ApplicationGatewaySnapshot["hello"];
}

function standingGrant(name: string): ExecApprovalStandingGrant {
  return {
    grantId: "grant-1",
    mintedByApprovalId: "approval-1",
    agentId: "main",
    cronJobId: "job-1",
    cronJobName: name,
    command: "id -un",
    cwd: null,
    createdAtMs: 1_000,
    expiresAtMs: null,
    revokedAtMs: null,
    revokedBy: null,
    lastUsedAtMs: null,
    useCount: 3,
  };
}

describe("ApprovalsPage", () => {
  it("keeps history and grants through a blip without allowing offline actions", async () => {
    const refreshedHistory = createDeferred<ApprovalHistoryResult>();
    const p = createPage(
      replyOnce(historyReply("retained", 2_000, "next")).mockReturnValue(refreshedHistory.promise),
      operatorAuth(["operator.approvals"]),
      () => Promise.resolve(grantReply("Retained automation")),
    );
    await p.waitGrants("Retained automation");
    p.updateGateway({ phase: "reconnecting", hello: null });
    expect(p.history()).toContain("echo retained");
    expect(p.grants()).toContain("Retained automation");
    expect(p.button()?.disabled).toBe(true);
    expect(p.query(".data-table-pagination button")).toMatchObject({ disabled: true });
    p.updateGateway({ phase: "connected", hello: operatorHello(["operator.approvals"]) });
    expect(p.history()).toContain("echo retained");
    refreshedHistory.resolve(historyReply("fresh", 3_000));
    await p.waitHistory("echo fresh");
    p.updateGateway({ client: createTestGatewayClient(p.request), phase: "reconnecting" });
    expect(p.page.textContent).not.toContain("echo fresh");
    expect(p.page.textContent).not.toContain("Retained automation");
  });

  it("does not claim an empty history when the load failed", async () => {
    const p = createPage(vi.fn().mockRejectedValueOnce(new Error("boom")));
    await p.waitError("boom");
    expect(p.text(`${historyTable} tbody`) ?? "").not.toContain("No resolved approvals");
  });

  it("retains accepted history through pending pagination, failure and retry", async () => {
    const firstRead = createDeferred<ApprovalHistoryResult>();
    const moreRead = createDeferred<ApprovalHistoryResult>();
    const retryRead = createDeferred<ApprovalHistoryResult>();
    const request = replyOnce(firstRead.promise, moreRead.promise, retryRead.promise);
    const p = createPage(request);
    await waitForSolid(() =>
      expect(p.query(".settings-loading-skeleton")?.getAttribute("aria-label")).toBe(
        "Loading approval history…",
      ),
    );
    firstRead.resolve(historyReply("retained", 2_000, "next"));
    await p.waitHistory("echo retained");
    const table = p.query(historyTable)!;
    const row = table.querySelector("tbody tr");
    const more = p.query<HTMLButtonElement>(".data-table-pagination button")!;
    const expectRow = (busy: string) => {
      expect(table.getAttribute("aria-busy")).toBe(busy);
      expect(table.querySelector("tbody tr")).toBe(row);
    };
    more.click();
    more.click();
    flush();
    expect(request).toHaveBeenCalledTimes(2);
    expectRow("true");
    expectButton(more, true, "Loading");
    moreRead.reject(new Error("History unavailable"));
    await waitForSolid(() => {
      expect(p.text('[role="alert"]')).toContain("History unavailable");
      expectRow("false");
      expect(more.disabled).toBe(false);
    });
    p.query<HTMLButtonElement>('[role="alert"] button')!.click();
    flush();
    expect(request).toHaveBeenLastCalledWith("approval.history", { limit: 50 });
    expectRow("true");
    expect(p.query('[role="alert"]')).toBeNull();
    retryRead.resolve(historyReply("retained", 3_000));
    await waitForSolid(() => expectRow("false"));
    expect(p.query(historyTable)).toBe(table);
  });

  it("keeps a failed initial grants read unknown until an accepted refresh", async () => {
    const refreshedGrants = createDeferred<ExecApprovalGrantsListResult>();
    const grants = vi
      .fn()
      .mockRejectedValueOnce(new Error("Ledger unavailable"))
      .mockReturnValue(refreshedGrants.promise);
    const p = createPage(undefined, undefined, grants);
    await p.waitError("Ledger unavailable");
    const table = p.query(grantsTable);
    expect(p.grants()).toContain("Unknown");
    expect(p.grants()).not.toContain("No standing grants");
    expect(p.query('[role="alert"] button')).toBeNull();
    p.resolveApproval();
    await waitForSolid(() => expect(grants).toHaveBeenCalledTimes(2));
    expect(p.grants()).toContain("Unknown");
    refreshedGrants.resolve({ grants: [] });
    await p.waitGrants("No standing grants");
    expect(p.query('[role="alert"]')).toBeNull();
    expect(p.query(grantsTable)).toBe(table);
  });

  it("refreshes the newest history after an approval resolves during pagination", async () => {
    const olderPage = createDeferred<ApprovalHistoryResult>();
    const request = replyOnce(historyReply("first", 2_000, "next"), olderPage.promise, {
      items: [terminal("newest", 3_000), terminal("first", 2_000)],
    });
    const p = createPage(request);
    await p.waitHistory("echo first");
    p.query<HTMLButtonElement>(".data-table-pagination button")!.click();
    flush();
    expect(request).toHaveBeenCalledTimes(2);

    p.resolveApproval("newest");
    expect(request).toHaveBeenCalledTimes(2);

    olderPage.resolve(historyReply("older", 1_000));
    await p.waitHistory("echo newest");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith("approval.history", { limit: 50 });
  });

  it.each([
    { name: "read-only", scopes: ["operator.read"], allowed: false },
    { name: "legacy", scopes: undefined, allowed: true },
  ])("gates history for a $name operator", async ({ scopes, allowed }) => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const p = createPage(request, operatorAuth(scopes));
    await waitForSolid(() => expect(p.query(historyTable) !== null).toBe(allowed));
    expect(request.mock.calls).toEqual(allowed ? [["approval.history", { limit: 50 }]] : []);
    if (!allowed) {
      expect(p.text('[role="status"]')).toContain("operator.approvals");
    }
  });

  it("discards stale history when approval access changes on the same gateway", async () => {
    const staleHistory = createDeferred<ApprovalHistoryResult>();
    const request = replyOnce(staleHistory.promise, historyReply("current", 2_000));
    const p = createPage(request, operatorAuth(["operator.approvals"]));
    expect(request).toHaveBeenCalledOnce();

    p.updateGateway({ hello: operatorHello(["operator.read"]) });
    p.resolveApproval("inaccessible");
    flush();
    expect(request).toHaveBeenCalledOnce();
    expect(p.query(historyTable)).toBeNull();
    p.updateGateway({ hello: operatorHello(["operator.admin"]) });
    await p.waitHistory("echo current");
    expect(request).toHaveBeenCalledTimes(2);

    staleHistory.resolve(historyReply("stale", 1_000));
    await staleHistory.promise;
    flush();
    expect(p.history()).toContain("echo current");
    expect(p.history()).not.toContain("echo stale");
  });

  it.each(["client", "source", "account", "recovery scope"] as const)(
    "clears standing grants while a replacement %s loads its ledger",
    async (replacement) => {
      const nextGrants = createDeferred<ExecApprovalGrantsListResult>();
      const p = createPage(
        undefined,
        operatorAuth(undefined, "scope-first"),
        replyOnce(grantReply(oldAutomation)).mockReturnValue(nextGrants.promise),
      );
      p.updateGateway({ selfUser: { id: "first" } });
      await p.waitGrants(oldAutomation);
      p.replaceGateway(replacement);
      expect(p.grants()).not.toContain(oldAutomation);
      expect(p.button()).toBeNull();
      nextGrants.resolve(grantReply(currentAutomation));
      await p.waitGrants(currentAutomation);
    },
  );

  it.each([
    { replacement: "source", outcome: "resolve" },
    { replacement: "client", outcome: "reject" },
  ] as const)(
    "retires a previous $replacement revoke that later $outcome without settling the current revoke",
    async ({ replacement, outcome }) => {
      const oldRevoke = createDeferred<{ outcome: string }>();
      const currentRevoke = createDeferred<{ outcome: string }>();
      const revoke = replyOnce(oldRevoke.promise).mockReturnValue(currentRevoke.promise);
      const p = createPage(
        undefined,
        undefined,
        replyOnce(grantReply(oldAutomation)).mockResolvedValue(grantReply(currentAutomation)),
        revoke,
      );
      await waitForSolid(() => expect(p.button()).not.toBeNull());
      p.button()!.click();
      flush();
      p.replaceGateway(replacement);
      await p.waitGrants(currentAutomation);
      const currentButton = p.button()!;
      expect(currentButton.disabled).toBe(false);
      currentButton.click();
      flush();
      expectButton(currentButton, true, "Revoking");
      if (outcome === "resolve") {
        oldRevoke.resolve({ outcome: "revoked" });
      } else {
        oldRevoke.reject(new Error("Old Gateway revoke failed"));
      }
      await Promise.allSettled([oldRevoke.promise]);
      flush();
      expect(p.grants()).toContain("Until revoked");
      expect(p.page.textContent).not.toContain("Old Gateway revoke failed");
      expectButton(currentButton, true, "Revoking");
      currentRevoke.resolve({ outcome: "revoked" });
      await p.waitGrants("Revoked");
      expect(p.button()).toBeNull();
    },
  );

  it("retains the grant row and releases failed revoke feedback before retry", async () => {
    const failedRevoke = createDeferred<unknown>();
    const retryRevoke = createDeferred<unknown>();
    const revoke = replyOnce(failedRevoke.promise, retryRevoke.promise);
    const p = createPage(
      undefined,
      undefined,
      () => Promise.resolve(grantReply("Nightly backup")),
      revoke,
    );
    await p.waitGrants("Nightly backup");
    const button = p.button()!;
    const row = button.closest("tr");
    button.click();
    button.click();
    flush();
    expect(revoke).toHaveBeenCalledOnce();
    expectButton(button, true, "Revoking");
    expect(p.grants()).toContain("Until revoked");
    failedRevoke.reject(new Error("Revoke failed"));
    await waitForSolid(() => {
      expect(p.text('[role="alert"]')).toContain("Revoke failed");
      expect(button.disabled).toBe(false);
      expect(button.textContent?.trim()).toBe("Revoke");
    });
    expect(p.button()?.closest("tr")).toBe(row);
    button.click();
    flush();
    expect(button.disabled).toBe(true);
    retryRevoke.resolve({ outcome: "revoked" });
    await p.waitGrants("Revoked");
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(p.button()).toBeNull();
  });

  it("renders the standing-grant ledger and revokes through the gateway", async () => {
    const pendingRefresh = createDeferred<ExecApprovalGrantsListResult>();
    const grant = standingGrant("Nightly backup");
    const grants = replyOnce({ grants: [grant] }).mockReturnValue(pendingRefresh.promise);
    const p = createPage(undefined, undefined, grants, () =>
      Promise.resolve({ outcome: "revoked" }),
    );
    await p.waitGrants("Nightly backup");
    const ledger = p.query(grantsTable);
    expect(ledger?.textContent).toContain("id -un");
    expect(ledger?.textContent).toContain("Until revoked");
    p.resolveApproval("another-approval");
    await waitForSolid(() => expect(grants).toHaveBeenCalledTimes(2));
    const revoke = p.button();
    expect(revoke?.getAttribute("aria-label")).toBe("Revoke: Nightly backup — id -un");
    expect(ledger?.querySelector("th:last-child")?.textContent?.trim()).toBe("Revoke");
    revoke?.click();
    await p.waitGrants("Revoked");
    expect(p.request).toHaveBeenCalledWith("exec.approval.grants.revoke", { grantId: "grant-1" });
    pendingRefresh.resolve({ grants: [grant] });
    await pendingRefresh.promise;
    flush();
    expect(p.grants()).toContain("Revoked");
    expect(p.button()).toBeNull();
  });
});
