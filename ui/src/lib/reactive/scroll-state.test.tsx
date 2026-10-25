/* @vitest-environment jsdom */
import { createRoot, createSignal, flush, For } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useScrollState } from "../../components/solid/scroll-state.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { scheduleLayout } from "../layout-frame.ts";
import { createScrollPosition, createScrollStateRef } from "./scroll-state.ts";

const observers: TestResizeObserver[] = [];
const cleanup: Array<() => void> = [];

class TestResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly callback: (entries: ReadonlyArray<{ target: Element }>) => void) {
    observers.push(this);
  }
  observe = (element: Element) => this.targets.add(element);
  unobserve = (element: Element) => this.targets.delete(element);
  disconnect = () => this.targets.clear();
  deliver = (element: Element) => this.callback([{ target: element }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  observers.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function geometry(element: HTMLElement, horizontal = false) {
  const values = { extent: 300, viewport: 100, offset: 0 };
  Object.defineProperties(element, {
    [horizontal ? "scrollWidth" : "scrollHeight"]: { get: () => values.extent },
    [horizontal ? "clientWidth" : "clientHeight"]: { get: () => values.viewport },
    [horizontal ? "scrollLeft" : "scrollTop"]: {
      get: () => values.offset,
      set: (offset: number) => {
        values.offset = Math.max(0, Math.min(offset, values.extent - values.viewport));
      },
    },
  });
  return values;
}

function reflect(element: HTMLElement, state: { scrollable: boolean; atEnd: boolean }) {
  element.dataset.scrollable = String(state.scrollable);
  element.dataset.atEnd = String(state.atEnd);
}

function advanceFrame() {
  flush();
  vi.advanceTimersToNextFrame();
}

function expectFrame(element: HTMLElement, scrollable: boolean, atEnd: boolean, atStart?: boolean) {
  advanceFrame();
  expect(element.dataset).toMatchObject({ scrollable: String(scrollable), atEnd: String(atEnd) });
  if (atStart !== undefined) {
    expect(element.dataset.atStart).toBe(String(atStart));
  }
}

function div(parent = document.body) {
  const element = parent.appendChild(document.createElement("div"));
  cleanup.push(() => element.remove());
  return element;
}

function createScrollPositionRoot(...args: Parameters<typeof createScrollPosition>) {
  const stop = createRoot((dispose) => {
    createScrollPosition(...args);
    return dispose;
  });
  cleanup.push(stop);
  return stop;
}

function scroll(element: HTMLElement, values: ReturnType<typeof geometry>, offset: number) {
  values.offset = offset;
  element.dispatchEvent(new Event("scroll"));
}

type ScrollOptions = Parameters<typeof createScrollStateRef>[1];
function externalScroll(options: ScrollOptions = {}, publish = reflect) {
  const element = div();
  const values = geometry(element, options.horizontal);
  const root = createRoot((stop) => ({ stop, ref: createScrollStateRef(publish, options) }));
  cleanup.push(root.stop);
  root.ref(element);
  return { element, values, dispose: root.stop, ref: root.ref };
}

it.each([
  { horizontal: true, trackScroll: true },
  { horizontal: false, trackScroll: false },
])("tracks Solid-bound scroll state with %j", ({ horizontal, trackScroll }) => {
  const view = mountSolid(() => (
    <div role="region" ref={useScrollState(horizontal, trackScroll)} />
  ));
  cleanup.push(view.unmount);
  const element = view.getByRole("region");
  const values = geometry(element, horizontal);
  expectFrame(element, true, false, true);
  scroll(element, values, 200);
  expectFrame(element, true, trackScroll, !trackScroll);
  if (!trackScroll) {
    observers.at(-1)!.deliver(element);
    expectFrame(element, true, true, false);
  }
});

it("moves observation to the rendered replacement and ignores the old pending layout", () => {
  const [identity, setIdentity] = createSignal(0);
  const view = mountSolid(() => {
    const ref = createScrollStateRef(reflect);
    return <For each={[identity()]}>{() => <div role="region" ref={ref} />}</For>;
  });
  cleanup.push(view.unmount);
  const first = view.getByRole("region");
  const firstGeometry = geometry(first);
  expectFrame(first, true, false);
  const oldObserver = observers.at(-1)!;

  scroll(first, firstGeometry, 200);
  setIdentity(1);
  flush();
  const second = view.getByRole("region");
  geometry(second).extent = 100;
  oldObserver.deliver(first);
  vi.advanceTimersToNextFrame();

  expect(second).not.toBe(first);
  expect(first.dataset.atEnd).toBe("false");
  expect(second.dataset).toMatchObject({ scrollable: "false", atEnd: "true" });
  expect(observers.filter((observer) => observer.targets.has(second))).toHaveLength(1);
  expect(observers.every((observer) => !observer.targets.has(first))).toBe(true);
});

it("resamples content on reveal and releases live external targets when disposed", () => {
  const publish = vi.fn(reflect);
  const [presented, setPresented] = createSignal(true);
  const [content, setContent] = createSignal("long path");
  const { element, values, dispose } = externalScroll(
    { presented, content, horizontal: true },
    publish,
  );
  expectFrame(element, true, false);
  const oldObserver = observers.at(-1)!;

  scroll(element, values, 200);
  setPresented(false);
  flush();
  values.extent = 100;
  values.offset = 0;
  setContent("short path");
  flush();
  oldObserver.deliver(element);
  vi.advanceTimersToNextFrame();
  expect(element.dataset.atEnd).toBe("false");
  expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);

  setPresented(true);
  expectFrame(element, false, true);
  publish.mockClear();
  values.extent = 400;
  setContent("a longer path");
  expectFrame(element, true, false);
  const atStart = { scrollable: true, atStart: true, atEnd: false };
  expect(publish).toHaveBeenCalledExactlyOnceWith(element, atStart);
  expect(observers.filter((observer) => observer.targets.has(element))).toHaveLength(1);

  scroll(element, values, 300);
  const retiringObserver = observers.at(-1)!;
  dispose();
  retiringObserver.deliver(element);
  element.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(element).toMatchObject({ isConnected: true, dataset: { atEnd: "false" } });
  expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
});

it("defers bounded reveal and cancels replaced, cleared, and disposed requests", () => {
  const ancestor = div();
  const region = div(ancestor);
  const first = region.appendChild(document.createElement("button"));
  const second = region.appendChild(document.createElement("button"));
  const outside = ancestor.appendChild(document.createElement("button"));
  vi.spyOn(region, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 200, 100));
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 240, 200, 20));
  vi.spyOn(second, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 80, 200, 20));
  const nativeScroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const [active, setActive] = createSignal<HTMLElement | null>(first);
  const select = (target: HTMLElement | null) => {
    setActive(target);
    flush();
  };
  ancestor.scrollTop = 400;
  Object.assign(region, { scrollTop: 100, scrollLeft: 25 });
  const stop = createScrollPositionRoot(
    () => {
      const initial = active();
      return initial ? { reveal: { identity: [initial], target: () => initial } } : {};
    },
    { region: () => region, revealTiming: "animation-frame" },
  );
  flush();
  expect(region.scrollTop).toBe(100);

  for (const [target, beforeFrame, top] of [
    [second, () => expect(region.scrollTop).toBe(100), 80],
    [first, undefined, 140],
    [second, () => select(null), 140],
    [outside, undefined, 140],
    [second, stop, 140],
  ] as const) {
    select(target);
    beforeFrame?.();
    vi.advanceTimersToNextFrame();
    expect(region.scrollTop).toBe(top);
  }
  expect([region.scrollLeft, ancestor.scrollTop]).toEqual([25, 400]);
  expect(nativeScroll).not.toHaveBeenCalled();
});

it("resamples loaded font metrics only for the current presented element", () => {
  const readiness = vi.fn(() => Promise.resolve());
  const fonts = new EventTarget();
  Object.defineProperty(fonts, "ready", { get: readiness });
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  cleanup.push(() => {
    if (originalFonts) {
      Object.defineProperty(document, "fonts", originalFonts);
    }
  });
  const [presented, setPresented] = createSignal(true);
  const publish = vi.fn(reflect);
  const {
    element: first,
    values: firstGeometry,
    ref,
    dispose,
  } = externalScroll({ horizontal: true, trackScroll: false, presented }, publish);
  const second = div();
  const secondGeometry = geometry(second, true);
  const expectScrollable = (element: HTMLElement, scrollable: boolean) => {
    advanceFrame();
    expect(element.dataset.scrollable).toBe(String(scrollable));
  };
  const loadFonts = () => fonts.dispatchEvent(new Event("loadingdone"));
  expectScrollable(first, true);

  ref(second);
  advanceFrame();
  firstGeometry.extent = 50;
  secondGeometry.extent = 50;
  loadFonts();
  expectScrollable(second, false);
  expect(first.dataset.scrollable).toBe("true");

  setPresented(false);
  flush();
  secondGeometry.extent = 300;
  loadFonts();
  expectScrollable(second, false);

  setPresented(true);
  expectScrollable(second, true);
  secondGeometry.extent = 50;
  loadFonts();
  loadFonts();
  publish.mockClear();
  expectScrollable(second, false);
  expect(publish).toHaveBeenCalledTimes(1);

  dispose();
  publish.mockClear();
  secondGeometry.extent = 300;
  loadFonts();
  vi.advanceTimersToNextFrame();
  expect(publish).not.toHaveBeenCalled();
  expect(readiness).not.toHaveBeenCalled();
});

it("restores a destination after readiness without overwriting subsequent reader scroll", () => {
  const outer = div();
  const element = div(outer);
  Object.defineProperty(element, "scrollWidth", { value: 700 });
  outer.scrollTop = 400;
  const [target, setTarget] = createSignal<HTMLElement>();
  const [ready, setReady] = createSignal(false);
  const [destination, setDestination] = createSignal("root");
  const [savedTop, setSavedTop] = createSignal(37);
  createScrollPositionRoot(() => {
    const currentTarget = target();
    return {
      restore: ready()
        ? {
            identity: [destination(), currentTarget],
            target: currentTarget,
            top: savedTop(),
            left: "end",
          }
        : undefined,
    };
  });
  const expectTop = (top: number) => {
    flush();
    expect(element.scrollTop).toBe(top);
  };
  setReady(true);
  flush();
  setTarget(element);
  expectTop(37);
  expect(element.scrollLeft).toBe(700);

  element.scrollTop = 91;
  setSavedTop(91);
  expectTop(91);
  setSavedTop(37);
  expectTop(91);

  setReady(false);
  flush();
  setDestination("folder");
  setSavedTop(12);
  expectTop(91);
  setReady(true);
  expectTop(12);
  expect(outer.scrollTop).toBe(400);
});

function retainedScroll() {
  const element = div();
  const values = geometry(element);
  const [state, setState] = createSignal({ key: "first", presented: true, ready: true });
  const dispose = createScrollPositionRoot(() => ({
    retain: {
      identity: [state().key],
      target: element,
      presented: state().presented,
      ready: state().ready,
    },
  }));
  const update = (patch: Partial<ReturnType<typeof state>> = {}, top?: number) => {
    setState((current) => ({ ...current, ...patch }));
    advanceFrame();
    if (top !== undefined) {
      expect(element.scrollTop).toBe(top);
    }
  };
  update();
  return { element, values, frame: update, setState, dispose };
}

it("restores retained scroll after accepted content and finishes when it is genuinely shorter", () => {
  const { element, values, frame } = retainedScroll();
  scroll(element, values, 160);
  frame({ presented: false });
  values.extent = 100;
  scroll(element, values, 0);
  frame({ presented: true, ready: false }, 0);
  values.extent = 400;
  frame({ ready: true }, 160);

  frame({ presented: false });
  values.extent = 150;
  values.offset = 0;
  frame({ presented: true, ready: false });
  frame({ ready: true }, 50);
  values.extent = 500;
  frame({}, 50);
});

it("lets user scrolling, a replacement scope and disposal cancel retained restoration", () => {
  const { element, values, frame, setState, dispose } = retainedScroll();
  scroll(element, values, 160);
  frame({ presented: false });
  values.offset = 0;
  frame({ presented: true, ready: false });
  element.dispatchEvent(new WheelEvent("wheel"));
  scroll(element, values, 20);
  frame({ ready: true }, 20);

  frame({ key: "second" }, 0);
  scroll(element, values, 90);
  frame({ presented: false });
  values.offset = 0;
  setState((current) => ({ ...current, presented: true }));
  flush();
  scheduleLayout({}, () => {
    dispose();
  });
  vi.advanceTimersToNextFrame();
  expect(element.scrollTop).toBe(0);
});
