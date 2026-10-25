import { expect, it } from "vitest";
import { captureBootRoster } from "../lib/sessions/session-boot-roster.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";
import { inboxMention } from "./sidebar-inbox.test-support.ts";
import {
  parseSidebarSnapshot,
  restoreSnapshotSession,
  snapshotSections,
  snapshotSessions,
  snapshotIssuesCount,
} from "./sidebar-snapshot-model.ts";
import { sidebarSnapshot as model } from "./sidebar-snapshot.test-support.ts";

function captureRoster(rows: Parameters<typeof sessionsResult>[0]) {
  return captureBootRoster({
    result: sessionsResult(rows, 1),
    agentId: "main",
    groups: [],
    groupSettings: [],
    sectionOrder: [],
    loading: false,
    error: null,
  });
}
function displayRow(key: string, label: string, pinned = false) {
  return restoreSnapshotSession(
    { key, label, pinned, isChild: false, children: [] },
    pinned ? key : "",
  );
}

it("omits private session contributions from the saved Inbox count", () => {
  const incognito = "agent:main:dashboard:incognito-private";
  const outbox: SidebarInboxEntry = {
    type: "outbox",
    category: "system",
    severity: "warning",
    dismissal: null,
    requiresAction: true,
    id: "public",
    sessionKey: "agent:main:public",
    held: true,
    command: false,
  };
  const approval: SidebarInboxEntry = {
    type: "approval",
    category: "approvals",
    severity: "warning",
    dismissal: null,
    requiresAction: true,
    approval: {
      id: "approval",
      kind: "exec",
      request: { command: "synthetic", sessionKey: incognito },
      createdAtMs: 0,
      expiresAtMs: 1,
    },
  };
  expect(
    snapshotIssuesCount([
      outbox,
      { ...outbox, id: "private", sessionKey: incognito },
      approval,
      {
        ...approval,
        approval: {
          ...approval.approval,
          request: { command: "synthetic", sessionKey: "agent:main:parent" },
          sourceSessionKey: incognito,
        },
      },
      {
        type: "mention",
        category: "mentions",
        severity: "neutral",
        dismissal: null,
        requiresAction: true,
        mention: { ...inboxMention("private"), sessionKey: incognito },
      },
      { ...outbox, id: "quiet", requiresAction: false },
    ]),
  ).toBe(1);
});

it("roundtrips hidden-run child queries without retaining incognito parent keys", () => {
  const parent = displayRow("agent:main:parent", "Parent");
  const child = displayRow("agent:main:child", "Child");
  const hiddenRun = "agent:main:subagent:review";
  const incognitoRun = "agent:main:subagent:incognito-private";
  const captured = snapshotSessions([
    { ...parent, children: [child], childLoadParentKeys: [parent.key, hiddenRun, incognitoRun] },
  ]);
  expect(captured[0]?.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  const saved = parseSidebarSnapshot(structuredClone({ ...model, pinnedSessions: captured }));
  expect(saved).not.toBeNull();
  const restored = restoreSnapshotSession(saved!.pinnedSessions[0]!, parent.key);
  expect(restored.childLoadParentKeys).toEqual([parent.key, hiddenRun]);
  expect(restored.children.map((row) => row.key)).toEqual([child.key]);
  const legacyParent = { ...captured[0], childLoadParentKeys: undefined };
  expect(parseSidebarSnapshot({ ...model, pinnedSessions: [legacyParent] })).toBeNull();
  expect(
    parseSidebarSnapshot({ ...model, pinnedSessions: [{ ...legacyParent, children: [] }] }),
  ).not.toBeNull();
  expect(
    parseSidebarSnapshot({
      ...model,
      pinnedSessions: [{ ...captured[0], childLoadParentKeys: [parent.key, incognitoRun] }],
    }),
  ).toBeNull();
});

it("keeps primary routing and header facts in the display snapshot without private or live authority", () => {
  const stable = {
    key: "agent:main:dashboard:cedar",
    kind: "direct" as const,
    displayName: "Cedar",
    boardFace: "dashboard" as const,
    boardPresentation: "expanded" as const,
    workspaceDir: "/synthetic/workspace",
  };
  const liveRow = {
    ...stable,
    sharingRole: "owner" as const,
    hasActiveRun: true,
    activeModel: "stale-model",
  };
  const roster = captureRoster([
    liveRow,
    { key: "agent:main:private", kind: "direct", incognito: true, label: "Private title" },
  ]);
  const saved = parseSidebarSnapshot({ ...model, roster });
  expect(saved?.roster?.result.sessions).toEqual([stable]);
  expect(JSON.stringify(saved)).not.toMatch(/Private title|sharingRole|hasActiveRun|activeModel/u);
  expect(
    parseSidebarSnapshot({
      ...saved,
      roster: { ...roster, result: sessionsResult([{ ...stable, incognito: true }], 1) },
    }),
  ).toBeNull();
});

it("admits the sidebar after the live roster grows beyond the boot window", () => {
  const sessions = Array.from({ length: 240 }, (_, index) => ({
    key: `agent:main:session-${index}`,
    kind: "direct" as const,
    label: `Session ${index}`,
  }));
  const roster = captureRoster(sessions);
  const saved = parseSidebarSnapshot({ ...model, roster });
  expect(saved?.roster?.result.sessions).toEqual(sessions.slice(0, 200));
});

it("keeps display data without persisting authority, executable plugins, or watched sessions", () => {
  const plugin = { key: "reports/main", pluginId: "reports", id: "main", label: "Reports" };
  const card = { id: "main", name: "Harbor", mainKey: "agent:main:main" };
  const admitted = parseSidebarSnapshot({
    ...model,
    token: "synthetic-secret",
    footer: { ...model.footer, scopes: ["operator.admin"] },
    plugins: [{ ...plugin, mount() {} }],
    cards: [{ ...card, activeNow: true, lastActiveAt: 99 }],
  });
  expect(admitted?.footer).toEqual(model.footer);
  expect(admitted?.plugins).toEqual([plugin]);
  expect(admitted?.cards).toEqual([card]);
  expect(admitted).not.toHaveProperty("token");
  expect(
    parseSidebarSnapshot({
      ...model,
      onlineUsers: [{ id: "operator", watchedSessions: ["private-session"] }],
    }),
  ).toBeNull();
});

it("excludes incognito roots and descendants and restores no live mutation facts", () => {
  const row = displayRow("agent:main:visible", "Project", true);
  const privateRow = { ...row, key: "agent:main:private", incognito: true };
  const publicChild = { ...row, key: "agent:main:child", children: [] };
  const captured = snapshotSessions(
    [
      {
        ...row,
        children: [privateRow, publicChild],
        sharingRole: "owner",
        activeRunIds: ["live-run"],
      },
      privateRow,
    ],
    (current) => ({
      childrenDisplayMode: "expanded",
      snapshotSubtitle:
        current.key === row.key ? { subtitle: "Private child approval details" } : undefined,
    }),
  );
  expect(captured).toHaveLength(1);
  expect(captured[0]?.children.map((row) => row.key)).toEqual([publicChild.key]);
  expect(captured[0]?.childrenDisplayMode).toBe("expanded");
  expect(captured[0]?.snapshotSubtitle).toBeUndefined();
  expect(JSON.stringify(captured)).not.toContain("Private child approval details");
  const restored = restoreSnapshotSession(captured[0]!, row.key);
  expect(restored).toMatchObject({ visuallyActive: true, pinnable: false });
  expect([restored.sharingRole, restored.activeRunIds]).toEqual([undefined, undefined]);
});

it("restores visible unread, activity and glyph facts without retaining attention text or run authority", () => {
  const row = {
    ...displayRow("agent:main:visible", "Project"),
    unread: true,
    hasActiveRun: true,
    hasAutomation: true,
    attention: {
      kind: "agent",
      icon: "key",
      note: "Private status text",
      sourceSessionKey: "another-session",
    } as const,
    ownAttention: { kind: "none" } as const,
    runningChildCount: 2,
  };
  const [saved] = snapshotSessions([row]);
  const parsed = parseSidebarSnapshot({ ...model, pinnedSessions: [saved] });
  expect(parsed).not.toBeNull();
  const restored = restoreSnapshotSession(parsed!.pinnedSessions[0]!, row.key);
  expect(restored).toMatchObject({
    unread: true,
    hasAutomation: true,
    isRunVisuallyActive: true,
    runningChildCount: 2,
    hasActiveRun: false,
    attention: { kind: "agent", icon: "key", note: "" },
    ownAttention: { kind: "none" },
  });
  expect(JSON.stringify(parsed)).not.toMatch(/Private status text|another-session/);
  expect(
    parseSidebarSnapshot({
      ...model,
      pinnedSessions: [{ ...saved, state: { attention: { kind: "agent" } } }],
    }),
  ).toBeNull();
});

it("omits incognito-only section metadata and counts while preserving existing empty groups", () => {
  const visible = displayRow("agent:main:public", "Public");
  const hidden = { ...visible, key: "agent:main:private", incognito: true };
  const counts = {
    totalRowCount: 2,
    visibleRowCount: 2,
    visibleLimit: 10,
    collapsedVisibleRowCount: 2,
    renderHeader: true,
  };
  const sections: Parameters<typeof snapshotSections>[0] = [
    {
      ...counts,
      id: "project:private-path",
      project: { name: "Private project", path: "/private/project" },
      rows: [hidden],
    },
    {
      ...counts,
      id: "person:private-person",
      personOwner: { type: "human", id: "private-person", label: "Private person" },
      rows: [hidden],
    },
    { ...counts, id: "category:shared", category: "Shared", rows: [visible, hidden] },
    {
      ...counts,
      id: "category:empty",
      category: "Empty",
      rows: [],
      totalRowCount: 0,
      visibleRowCount: 0,
      collapsedVisibleRowCount: 0,
    },
  ];
  const captured = snapshotSections(sections, new Set([...sections.map(({ id }) => id), "online"]));
  const admitted = parseSidebarSnapshot({ ...model, ...captured });
  expect(admitted?.sections.map((section) => section.id)).toEqual([
    "category:shared",
    "category:empty",
  ]);
  expect(admitted?.sections[0]).toMatchObject({
    totalRowCount: 1,
    visibleRowCount: 1,
    collapsedVisibleRowCount: 1,
  });
  expect(admitted?.sections[1]?.totalRowCount).toBe(0);
  expect(admitted?.collapsedSections).toEqual(["category:shared", "category:empty", "online"]);
  expect(JSON.stringify(admitted)).not.toContain("private");
});

it("retains independently rendered Pinned collapse state through snapshot serialization", () => {
  const captured = snapshotSections([], new Set(["pinned", "online", "category:gone"]));
  const serialized = JSON.stringify({ ...model, ...captured });
  const saved = parseSidebarSnapshot(JSON.parse(serialized));
  expect(saved?.collapsedSections).toEqual(["pinned", "online"]);
});
