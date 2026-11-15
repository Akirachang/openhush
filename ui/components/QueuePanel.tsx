"use client";
import { browse, remove, reveal, select } from "@/lib/controller";
import { basename, fmtTime } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { FileItem } from "@/lib/types";
import { IconAudio, IconFile, IconPlus, IconVideo, IconX } from "./icons";

function subText(f: FileItem): { text: string; tone: "muted" | "err" | "ok" } {
  switch (f.status) {
    case "probing":
      return { text: "Reading…", tone: "muted" };
    case "ready":
      return { text: f.info?.label ?? "Ready", tone: "muted" };
    case "queued":
      return { text: "Waiting…", tone: "muted" };
    case "running":
      return { text: `Cleaning ${Math.round((f.progress ?? 0) * 100)}%`, tone: "muted" };
    case "done":
      return { text: `Saved · ${basename(f.output ?? "")}`, tone: "ok" };
    case "cancelled":
      return { text: "Cancelled", tone: "muted" };
    default:
      return { text: f.error?.message ?? "Couldn't be cleaned", tone: "err" };
  }
}

function Row({ f, selected, locked }: { f: FileItem; selected: boolean; locked: boolean }) {
  const sub = subText(f);
  const isError = f.status === "failed" || f.status === "invalid";
  return (
    <div
      className={`group relative flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 ${selected ? "bg-select" : "hover:bg-row"}`}
    >
      <button
        type="button"
        onClick={() => select(f.id)}
        onDoubleClick={() => f.status === "done" && reveal(f)}
        aria-current={selected ? "true" : undefined}
        className="absolute inset-0 rounded-lg"
        aria-label={`${f.name}: ${sub.text}`}
      />
      <span className={`pointer-events-none flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-chip ${isError ? "text-err" : "text-ink"}`}>
        {!f.info && isError ? <IconFile /> : f.info?.kind === "video" ? <IconVideo /> : <IconAudio />}
      </span>
      <span className="pointer-events-none flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium">{f.name}</span>
        <span className={`flex items-center gap-1.5 text-[12px] ${sub.tone === "err" ? "text-err" : sub.tone === "ok" ? "text-ok" : "text-muted"}`}>
          {f.status === "running" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red" />}
          <span className="truncate">{sub.text}</span>
        </span>
        {f.status === "running" && (
          <span className="block h-[2px] overflow-hidden rounded bg-track">
            <span className="block h-[2px] bg-ink transition-[width] duration-300" style={{ width: `${(f.progress ?? 0) * 100}%` }} />
          </span>
        )}
      </span>
      <span className="pointer-events-none font-mono text-[11px] text-muted group-hover:opacity-0">
        {f.info ? fmtTime(f.info.duration) : ""}
      </span>
      {!locked && (
        <button
          type="button"
          onClick={() => remove([f.id])}
          aria-label={`Remove ${f.name} from the list`}
          className="absolute right-2 z-10 flex h-6 w-6 items-center justify-center rounded-md text-muted opacity-0 hover:bg-chip hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        >
          <IconX />
        </button>
      )}
    </div>
  );
}

export default function QueuePanel() {
  const files = useStore((s) => s.files);
  const selectedId = useStore((s) => s.selectedId);
  const batch = useStore((s) => s.batch);
  return (
    <aside className="flex w-[280px] shrink-0 flex-col rounded-[14px] bg-panel px-2 py-3">
      <div className="flex items-center justify-between px-2 pb-2.5">
        <span className="label">Queue · {files.length}</span>
        <button type="button" onClick={() => void browse()} aria-label="Add files"
          className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-chip">
          <IconPlus />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {files.map((f) => (
          <Row key={f.id} f={f} selected={f.id === selectedId}
            locked={batch.running && batch.ids.includes(f.id) && (f.status === "running" || f.status === "queued")} />
        ))}
        {!files.length && <p className="px-2 text-[12px] text-muted">No files yet.</p>}
      </div>
      <div className="m-2 mt-3 rounded-[10px] border border-dashed border-faint p-3.5 text-center text-[12px] text-muted">
        Drop audio or video anywhere
      </div>
    </aside>
  );
}
