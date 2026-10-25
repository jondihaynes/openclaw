/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createFrameQueue } from "../../test-helpers/animation-frame-queue.ts";
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

it("uses the card boundary before loading a preview inside skipped offscreen content", async () => {
  const { frames, request } = createFrameQueue();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(request);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  const card = document.createElement("article");
  vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -1_000, 320, 180));
  const { container } = mountSolid(() => <DashboardPreview viewportTarget={() => card} />);

  flush();
  frames.shift()?.(0);
  flush();
  await vi.dynamicImportSettled();
  flush();
  expect(container.textContent).not.toContain("Preview unavailable");
});

it("resumes near-viewport rendering and its error boundary after being remounted", async () => {
  const { frames, request } = createFrameQueue();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(request);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  const card = document.createElement("article");
  let setVisible!: (value: boolean) => void;
  const { container } = mountSolid(() => {
    const [visible, set] = createSignal(true);
    setVisible = set;
    return (
      <Show when={visible()}>
        <DashboardPreview viewportTarget={() => card} />
      </Show>
    );
  });

  flush();
  frames.shift()?.(0);
  flush();
  await waitForSolid(() => expect(container.textContent).toContain("Preview unavailable"));

  setVisible(false);
  flush();
  expect(container.textContent).not.toContain("Preview unavailable");

  setVisible(true);
  flush();
  frames.shift()?.(0);
  flush();
  await waitForSolid(() => expect(container.textContent).toContain("Preview unavailable"));
});
