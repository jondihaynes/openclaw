// Synthetic projection/PR-lineage workload. Run only on an approved benchmark host.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({ options: { "state-dir": { type: "string" } } });
assert.ok(values["state-dir"], "--state-dir must name a new isolated directory");
const directory = path.resolve(values["state-dir"]);
const { env } = await generateTeamShapeFixture(
  parseTeamShapeOptions([
    "--state-dir",
    directory,
    "--sessions",
    "10800",
    "--runs",
    "4300",
    "--settled-runs",
    "--team-stress",
    "--transcript-mib",
    "0",
    "--projects",
    "0",
    "--approvals",
    "0",
    "--cron",
    "0",
  ]),
);
process.env = env;
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { createSessionRowProjection } = await import("../../src/gateway/session-row-projection.js");
const { prepareTaskPublicationSessions } =
  await import("../../src/gateway/control-ui-session-task-prs.js");
const { replaceSessionEntrySync, loadSessionEntryReadOnly } =
  await import("../../src/config/sessions/session-accessor.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const cfg = JSON.parse(readFileSync(path.join(directory, "openclaw.json"), "utf8"));
setRuntimeConfigSnapshot(cfg);
const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
const rows = projection.selectEntries({ sortBy: null });
const parent = rows.find((row) => row.key.includes(":dashboard:"))!;
assert.ok(parent, "Expected a synthetic dashboard");
const query = { agentId: parent.agentId, key: parent.key, storePath: parent.storeTarget.storePath };
let event = "initial";
const census: Record<string, { calls: number; rows: number; stacks: Record<string, number> }> = {};
const select = projection.selectEntries;
projection.selectEntries = (...args) => {
  const result = select(...args);
  if (args[0]?.parentSessionKey) {
    const record = (census[event] ??= { calls: 0, rows: 0, stacks: {} });
    record.calls++;
    record.rows += result.length;
    const stack = new Error().stack!.split("\n").slice(2, 8).join("\n");
    record.stacks[stack] = (record.stacks[stack] ?? 0) + 1;
  }
  return result;
};
const consume = () => {
  const root = projection.capture(query)!;
  assert.ok(root.entry);
  const selected = prepareTaskPublicationSessions(
    projection,
    { ...root, entry: root.entry },
    () => () => true,
  );
  selected.assertCurrent();
  return selected.sessions.map((session) => session.sessionKey);
};
try {
  const child = "agent:main:l221-child";
  const write = (key: string, patch: Parameters<typeof replaceSessionEntrySync>[1]) =>
    replaceSessionEntrySync({ agentId: "main", sessionKey: key }, patch);
  consume();
  event = "repeat";
  consume();
  event = "unrelated-create";
  write("agent:main:l221-unrelated", { sessionId: "unrelated", updatedAt: 1 });
  await projection.ensureMaterialized();
  consume();
  event = "spawn";
  write(child, {
    sessionId: "child",
    updatedAt: 2,
    parentSessionKey: parent.key,
    spawnedBy: parent.key,
  });
  await projection.ensureMaterialized();
  assert.ok(consume().includes(child));
  for (const [name, patch] of [
    ["status", { status: "done" as const }],
    ["archive", { archivedAt: 3 }],
    ["replace", { sessionId: "replacement" }],
    [
      "reparent",
      { parentSessionKey: "agent:main:l221-unrelated", spawnedBy: "agent:main:l221-unrelated" },
    ],
  ] as const) {
    event = name;
    const current = loadSessionEntryReadOnly({ agentId: "main", sessionKey: child })!;
    write(child, { ...current, ...patch });
    await projection.ensureMaterialized();
    const selected = consume();
    assert.equal(selected.includes(child), name !== "reparent");
  }
  const result = { sessions: rows.length, parent: "synthetic dashboard", census };
  writeFileSync(
    path.join(directory, "parent-selection-census.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  projection.dispose();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
