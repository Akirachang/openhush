"use client";
import { useEffect, useRef } from "react";
import { api, hasApi } from "@/lib/bridge";
import * as c from "@/lib/controller";
import { get, set, useStore } from "@/lib/store";
import Banner from "./Banner";
import EmptyState from "./EmptyState";
import HeavyDialog from "./HeavyDialog";
import PreviewPane from "./PreviewPane";
import QueuePanel from "./QueuePanel";
import SettingsPanel from "./SettingsPanel";
import TitleBar from "./TitleBar";
import UpdateBanner from "./UpdateBanner";

function isTyping(el: EventTarget | null) {
  return el instanceof HTMLInputElement && !["range", "checkbox", "button"].includes(el.type);
}

export default function App() {
  const hasFiles = useStore((s) => s.files.length > 0);
  const dragging = useStore((s) => s.dragging);
  const depth = useRef(0);

  useEffect(() => c.initApp(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const p = get().preview;
      if (e.code === "Space") {
        e.preventDefault();
        c.togglePlay();
      } else if (e.key === "Tab" && p.status === "ready") {
        e.preventDefault();
        c.setCleaned(!p.cleaned);
      } else if (e.key === "a" || e.key === "A") {
        c.setCleaned(false);
      } else if (e.key === "b" || e.key === "B") {
        c.setCleaned(true);
      } else if (e.key === "ArrowDown" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        c.moveSelection(1);
      } else if (e.key === "ArrowUp" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        c.moveSelection(-1);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // Drops anywhere in the window add files. (Electron would otherwise navigate to the dropped file.)
  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    depth.current += 1;
    set({ dragging: true });
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (!depth.current) set({ dragging: false });
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    set({ dragging: false });
    if (!hasApi()) return;
    const paths = Array.from(e.dataTransfer.files).map((f) => api().pathForFile(f)).filter(Boolean);
    if (paths.length) void c.addPaths(paths);
  };

  return (
    <div
      className="flex h-screen flex-col bg-app text-ink"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <TitleBar />
      <UpdateBanner />
      <Banner />
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <QueuePanel />
        <main className="relative min-w-0 flex-1 overflow-hidden rounded-[14px] bg-canvas">
          {hasFiles ? <PreviewPane /> : <EmptyState />}
        </main>
        <SettingsPanel />
      </div>
      {dragging && (
        <div className="pointer-events-none fixed inset-2 z-40 flex items-center justify-center rounded-[16px] border-2 border-dashed border-ink bg-[var(--overlay)]">
          <div className="flex flex-col items-center gap-2">
            <span className="text-[40px] font-semibold tracking-[-0.045em]">Drop to add</span>
            <span className="label">audio · video · folders</span>
          </div>
        </div>
      )}
      <HeavyDialog />
    </div>
  );
}
