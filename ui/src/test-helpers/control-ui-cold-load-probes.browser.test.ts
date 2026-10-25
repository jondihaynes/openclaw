import { describe, expect, it } from "vitest";
import { createColdLoadProbeInitScript } from "./control-ui-cold-load-probes.ts";
import { sidebarPresentationProbe } from "./control-ui-sidebar-presentation-probe.test-support.ts";

describe("serialized cold-load probes", () => {
  it.each([true, false])(
    "rejects an incomplete sidebar handoff (blank frame: %s)",
    async (blank) => {
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      try {
        const target = iframe.contentWindow;
        const doc = iframe.contentDocument;
        if (!target || !doc) throw new Error("Probe realm was not created");
        const script = doc.createElement("script");
        script.textContent = `
        const __name = fn => fn;
        const frames = [];
        window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
        const aside = document.createElement("aside");
        aside.className = "sidebar";
        aside.dataset.snapshotState = "cached";
        const row = '<div class="sidebar-recent-session" data-session-key="synthetic" style="height:20px;width:100px"></div>';
        aside.innerHTML = '<div class="sidebar-shell__body sidebar-session-content" style="height:80px">'+row+'</div>';
        document.body.append(aside);
        (${sidebarPresentationProbe.toString()})();
        window.sidebarProof = (async () => {
          frames.shift()(0);
          if (${blank}) {
            aside.firstElementChild.innerHTML = "";
            await Promise.resolve();
            frames.shift()(0);
            aside.dataset.snapshotState = "live";
            aside.firstElementChild.innerHTML = row;
            await Promise.resolve();
            frames.shift()(0);
          }
          return __sidebarPresentation.read();
        })();
      `;
        doc.body.append(script);
        const proof = await Reflect.get(target, "sidebarProof");
        expect(proof.handoffChanges).toBeNull();
        expect(proof.frames.map((frame: { rows: unknown[] }) => frame.rows.length)).toEqual(
          blank ? [1, 0, 1] : [1],
        );
      } finally {
        iframe.remove();
      }
    },
  );

  it("preserves event order when latency timers become ready out of order without holding replies", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const target = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!target || !doc) {
        throw new Error("Probe realm was not created");
      }
      const script = doc.createElement("script");
      script.textContent = `
        const timers = [];
        window.setTimeout = callback => { timers.push(callback); return timers.length; };
        window.WebSocket = class extends EventTarget { send() {} };
        ${createColdLoadProbeInitScript({ ownerProbes: false, latencyMs: 100, frameGapMs: 0, events: [] })}
        const socket = new WebSocket();
        const delivered = [];
        window.orderedEventProof = new Promise(resolve => {
          socket.addEventListener("message", message => {
            const frame = JSON.parse(message.data);
            delivered.push(frame.type === "event" ? frame.seq : frame.id);
            if (delivered.length === 3) {
              socket.dispatchEvent(new Event("close"));
              resolve({ delivered, queued: __coldLoad.read().queued });
            }
          });
        });
        for (const seq of [1, 2]) {
          socket.dispatchEvent(new MessageEvent("message", {data: JSON.stringify({type: "event", event: "example", seq})}));
        }
        socket.send(JSON.stringify({type: "req", id: "fast", method: "chat.startup"}));
        socket.dispatchEvent(new MessageEvent("message", {data: JSON.stringify({type: "res", id: "fast", ok: true, payload: {}})}));
        const ready = timers.splice(0);
        ready[1]();
        ready[2]();
        ready[0]();
      `;
      doc.body.append(script);
      expect(await Reflect.get(target, "orderedEventProof")).toEqual({
        delivered: ["fast", 1, 2],
        queued: 0,
      });
    } finally {
      iframe.remove();
    }
  });

  it("serializes ready reply bytes on the selected download link", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const target = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!target || !doc) {
        throw new Error("Probe realm was not created");
      }
      const script = doc.createElement("script");
      script.textContent = `
        Object.defineProperty(performance, "now", { value: () => 0 });
        const timers = [];
        window.setTimeout = (callback, delay) => { timers.push({callback, delay}); return timers.length; };
        window.WebSocket = class extends EventTarget { send() {} };
        ${createColdLoadProbeInitScript({ ownerProbes: false, latencyMs: 100, downloadKbps: 8, frameGapMs: 0, events: [] })}
        const socket = new WebSocket();
        let delivered = 0;
        socket.addEventListener("message", () => delivered++);
        const data = JSON.stringify({type: "event", event: "example", payload: "é"});
        socket.dispatchEvent(new MessageEvent("message", {data}));
        socket.dispatchEvent(new MessageEvent("message", {data}));
        const eligibility = timers.splice(0);
        eligibility.forEach(timer => timer.callback());
        const delivery = timers.splice(0);
        const before = delivered;
        delivery.forEach(timer => timer.callback());
        window.downloadProof = {
          eligibility: eligibility.map(timer => timer.delay),
          delivery: delivery.map(timer => timer.delay),
          bytes: new TextEncoder().encode(data).length,
          before, delivered
        };
      `;
      doc.body.append(script);
      const proof = Reflect.get(target, "downloadProof");
      expect(proof.eligibility).toEqual([100, 100]);
      expect(proof.delivery).toEqual([proof.bytes, proof.bytes * 2]);
      expect(proof.before).toBe(0);
      expect(proof.delivered).toBe(2);
    } finally {
      iframe.remove();
    }
  });

  it("retires closed-socket requests without losing their RPC count or another socket's work", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const target = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!target || !doc) {
        throw new Error("Probe realm was not created");
      }
      const script = doc.createElement("script");
      script.textContent = `
        const timers = [];
        window.setTimeout = callback => { timers.push(callback); return timers.length; };
        window.WebSocket = class extends EventTarget { send() {} };
        ${createColdLoadProbeInitScript({ ownerProbes: false, latencyMs: 0, frameGapMs: 0, events: [] })}
        const oldSocket = new WebSocket();
        const currentSocket = new WebSocket();
        oldSocket.send(JSON.stringify({type: "req", id: "old", method: "sessions.list"}));
        currentSocket.send(JSON.stringify({type: "req", id: "current", method: "chat.startup"}));
        let oldEvents = 0, currentEvents = 0;
        oldSocket.addEventListener("message", () => oldEvents++);
        currentSocket.addEventListener("message", () => currentEvents++);
        const data = JSON.stringify({type: "event", event: "example", seq: 1});
        oldSocket.dispatchEvent(new MessageEvent("message", {data}));
        currentSocket.dispatchEvent(new MessageEvent("message", {data}));
        oldSocket.dispatchEvent(new Event("close"));
        timers.splice(0).forEach(ready => ready());
        const afterFirst = __coldLoad.read();
        const first = { pending: afterFirst.pendingMethods, rpcs: afterFirst.rpcs.map(rpc => ({ method: rpc.method, abandoned: rpc.abandoned })), oldEvents, currentEvents, queued: afterFirst.queued };
        currentSocket.dispatchEvent(new Event("close"));
        const afterSecond = __coldLoad.read();
        window.closedSocketProof = { first, pending: afterSecond.pending, rpcs: afterSecond.rpcs.length };
      `;
      doc.body.append(script);
      expect(Reflect.get(target, "closedSocketProof")).toEqual({
        first: {
          pending: ["chat.startup"],
          rpcs: [{ method: "sessions.list", abandoned: true }],
          oldEvents: 0,
          currentEvents: 1,
          queued: 0,
        },
        pending: 0,
        rpcs: 2,
      });
    } finally {
      iframe.remove();
    }
  });

  it("holds the challenge until connect can leave without an intercepted send", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const target = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!target || !doc) {
        throw new Error("Probe realm was not created");
      }
      const script = doc.createElement("script");
      script.textContent = `
        const timers = [];
        window.setTimeout = (callback, delay) => { timers.push({callback, delay}); return timers.length; };
        const sent = [];
        window.WebSocket = class extends EventTarget { send(data) { sent.push(JSON.parse(data).method); } };
        ${createColdLoadProbeInitScript({ ownerProbes: false, latencyMs: 0, frameGapMs: 0, connectNotBeforeMs: 1e9, events: [] })}
        const socket = new WebSocket();
        let challenges = 0;
        socket.addEventListener("message", () => {
          challenges++;
          socket.send(JSON.stringify({type: "req", id: "connect", method: "connect"}));
        });
        socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({type: "event", event: "connect.challenge", payload: {nonce: "synthetic"}}) }));
        const before = { challenges, sent: [...sent] };
        const timer = timers.shift();
        timer.callback();
        window.connectDispatchProof = { before, challenges, sent, delayed: timer.delay > 0, pendingTimers: timers.length };
      `;
      doc.body.append(script);
      expect(Reflect.get(target, "connectDispatchProof")).toEqual({
        before: { challenges: 0, sent: [] },
        challenges: 1,
        sent: ["connect"],
        delayed: true,
        pendingTimers: 0,
      });
    } finally {
      iframe.remove();
    }
  });

  it.each([true, false])("restores instrumentation with owner probes %s", async (ownerProbes) => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    try {
      const target = iframe.contentWindow;
      const doc = iframe.contentDocument;
      if (!target || !doc) {
        throw new Error("Probe realm was not created");
      }
      const script = doc.createElement("script");
      script.textContent = `
        const NativeWeakMap = WeakMap;
        const nativeSet = NativeWeakMap.prototype.set;
        const nativeFrame = requestAnimationFrame;
        ${createColdLoadProbeInitScript({ ownerProbes, latencyMs: 0, frameGapMs: 0, events: [] })}
        const nativeUntouched = NativeWeakMap.prototype.set === nativeSet;
        const map = new WeakMap([[{}, "iterable"]]);
        const sidebar = document.createElement("openclaw-app-sidebar");
        const page = document.createElement("openclaw-chat-page");
        const pane = document.createElement("openclaw-chat-pane");
        document.body.append(sidebar, page, pane);
        const owner = {
          hostElement: sidebar, isConnected: true,
          sessionData: { requestSessionDataUpdate() { return this; } },
          shouldPublishSessionData() { return true; },
          invalidate() { return this; }, prepareRender() { return this; }, commitRender() { return this; },
          releaseSidebarSnapshot() {}
        };
        const originalPublicationGate = owner.shouldPublishSessionData;
        if (${ownerProbes}) map.set(sidebar, owner);
        const paneOwner = {
          element: pane, isConnected: true,
          render() { return this; }
        };
        const originalRender = paneOwner.render;
        if (${ownerProbes}) map.set(pane, paneOwner);
        const restoredAfterCapture = WeakMap === NativeWeakMap && map.set === nativeSet;
        __coldLoad.startLive();
        const receiverPreserved = owner.invalidate() === owner &&
          owner.sessionData.requestSessionDataUpdate() === owner.sessionData &&
          paneOwner.render() === paneOwner;
        owner.prepareRender(); owner.commitRender();
        globalThis.openclawRenderLifecycleTestHook?.(paneOwner, "invalidate");
        paneOwner.render();
        globalThis.openclawRenderLifecycleTestHook?.(pane, "commit");
        globalThis.probeDone = new Promise(resolve => {
          requestAnimationFrame(() => {
            const live = __coldLoad.readLive();
            __coldLoad.finishLive();
            resolve({
              nativeUntouched, restoredAfterCapture, receiverPreserved,
              nativeRestored: WeakMap === NativeWeakMap && NativeWeakMap.prototype.set === nativeSet && requestAnimationFrame === nativeFrame,
              renderRestored: paneOwner.render === originalRender,
              publicationGateRestored: owner.shouldPublishSessionData === originalPublicationGate,
              storedOwner: ${ownerProbes} ? map.get(sidebar) === owner : !map.has(sidebar),
              ownerProbes: live.ownerProbes,
              sidebarMethods: live.solidSidebar?.passes.map(pass => pass.method) ?? [],
              chatPasses: live.solidChat?.passes.map(pass => pass.tag) ?? [],
              chatRequests: Object.keys(live.solidChat?.requests ?? {}).length,
              unmeasured: live.solidChat?.unmeasured ?? [],
              frameCount: Object.keys(live.solidChat?.frameOrigins ?? {}).length,
            });
          });
        });
      `;
      doc.body.append(script);
      expect(await Reflect.get(target, "probeDone")).toEqual({
        nativeUntouched: true,
        restoredAfterCapture: true,
        receiverPreserved: true,
        nativeRestored: true,
        renderRestored: true,
        publicationGateRestored: true,
        storedOwner: true,
        ownerProbes,
        sidebarMethods: ownerProbes ? ["invalidate", "prepareRender", "commitRender"] : [],
        chatPasses: ownerProbes ? ["openclaw-chat-pane", "openclaw-chat-pane"] : [],
        chatRequests: ownerProbes ? 1 : 0,
        unmeasured: ownerProbes
          ? ["page snapshot computations", "fine-grained Solid bindings"]
          : [],
        frameCount: ownerProbes ? 1 : 0,
      });
    } finally {
      iframe.remove();
    }
  });
});
