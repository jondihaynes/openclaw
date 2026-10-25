/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DashboardPreview } from "./dashboard-preview.tsx";

// mock-isolation: Exercise the lazy error boundary without registering the Board renderer or its providers.
vi.mock("../../components/board/board-document.tsx", () => ({
  OpenClawBoardDocument() {
    throw new Error("Preview unavailable");
  },
}));

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

it("resumes its error boundary after the card remounts its preview", async () => {
  let setVisible!: (value: boolean) => void;
  const { container } = mountSolid(() => {
    const [visible, set] = createSignal(true);
    setVisible = set;
    return (
      <Show when={visible()}>
        <DashboardPreview />
      </Show>
    );
  });

  flush();
  await waitForSolid(() => expect(container.textContent).toContain("Preview unavailable"));

  setVisible(false);
  flush();
  expect(container.textContent).not.toContain("Preview unavailable");

  setVisible(true);
  flush();
  await waitForSolid(() => expect(container.textContent).toContain("Preview unavailable"));
});
