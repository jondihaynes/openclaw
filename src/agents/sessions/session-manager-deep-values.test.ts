import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
      closeOpenClawAgentDatabasesForTest(dir);
    }
    cleanup();
  }),
);

function nestedArray(depth: number): unknown {
  let value: unknown = [1];
  for (let level = 0; level < depth; level++) {
    value = [value];
  }
  return value;
}

it("keeps a session appendable after a tool result with deeply nested details", async () => {
  const dir = tempDirs.make("openclaw-session-deep-values-");
  const scope = sessionScope(path.join(dir, "sessions.json"), "deep-details");
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = guardSessionManager(SessionManager.open(scope, { cwd: dir }), {});

  manager.appendMessage(makeUserMessage("run it", 1));
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }],
    api: "messages",
    provider: "anthropic",
    model: "sonnet-4.6",
    usage: createZeroUsageFixture(),
    stopReason: "toolUse",
    timestamp: 2,
  });
  // SQLite JSON functions reject documents nested deeper than 1000 levels.
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "probe",
    content: [{ type: "text", text: "done" }],
    details: nestedArray(1100),
    isError: false,
    timestamp: 3,
  });

  expect(() => manager.appendMessage(makeUserMessage("next turn", 4))).not.toThrow();
  const events = await loadTranscriptEvents(scope);
  expect(events.at(-1)).toMatchObject({ message: { role: "user", content: "next turn" } });
});
