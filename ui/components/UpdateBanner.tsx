"use client";
import { useEffect, useState } from "react";
import { api, hasApi, type UpdateState } from "@/lib/bridge";
import { useStore } from "@/lib/store";
import { Spinner } from "./icons";

const SHOWN = ["available", "downloading", "ready", "error", "unsupported"];

/** "OpenHush 0.3.0 is available · Update" → download → "Restart to update". */
export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [blocked, setBlocked] = useState("");
  const batchRunning = useStore((s) => s.batch.running);

  useEffect(() => {
    if (!hasApi()) return;
    void api().updates.get().then(setState);
    return api().updates.onState((s) => {
      setState(s);
      if (s.status === "available") setHidden(false);
    });
  }, []);

  if (!state || hidden || !SHOWN.includes(state.status)) return null;

  const later = (
    <button type="button" onClick={() => setHidden(true)} className="h-8 shrink-0 rounded-lg px-3 text-muted hover:text-ink">
      Later
    </button>
  );
  const notes = (url: string) => (
    <a href={url} target="_blank" rel="noreferrer" className="shrink-0 text-[13px] underline underline-offset-[3px]">
      What&apos;s new
    </a>
  );
  const restart = async () => {
    const reason = await api().updates.install();
    setBlocked(reason ?? "");
  };

  let body: React.ReactNode;
  let actions: React.ReactNode = null;
  switch (state.status) {
    case "available":
      body = <span><b className="font-medium">OpenHush {state.version}</b> is available. You have {state.current}.</span>;
      actions = (
        <>
          {notes(state.notesUrl)}
          {later}
          <button type="button" onClick={() => void api().updates.download()} className="h-8 shrink-0 rounded-lg bg-btn1 px-3.5 font-semibold text-btn1-ink">
            Update
          </button>
        </>
      );
      break;
    case "downloading":
      body = (
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <Spinner />
          <span className="shrink-0">Downloading OpenHush {state.version}…</span>
          <span className="h-[2px] max-w-[240px] flex-1 overflow-hidden rounded bg-track">
            <span className="block h-[2px] bg-ink transition-[width] duration-200" style={{ width: `${state.fraction * 100}%` }} />
          </span>
          <span className="font-mono text-[12px] tabular-nums">{Math.round(state.fraction * 100)}%</span>
        </span>
      );
      break;
    case "ready":
      body = (
        <span>
          <b className="font-medium">OpenHush {state.version}</b> is ready.{" "}
          <span className="text-muted">{blocked || (batchRunning ? "You can restart once cleaning finishes." : "Restarting takes a few seconds.")}</span>
        </span>
      );
      actions = (
        <>
          {later}
          <button type="button" onClick={() => void restart()} disabled={batchRunning}
            className="h-8 shrink-0 rounded-lg bg-btn1 px-3.5 font-semibold text-btn1-ink disabled:opacity-40">
            Restart to update
          </button>
        </>
      );
      break;
    case "unsupported":
      body = <span><b className="font-medium">OpenHush {state.version}</b> is available. <span className="text-muted">{state.message}</span></span>;
      actions = (
        <>
          {later}
          <a href={state.notesUrl} target="_blank" rel="noreferrer" className="flex h-8 shrink-0 items-center rounded-lg bg-btn1 px-3.5 font-semibold text-btn1-ink">
            Download
          </a>
        </>
      );
      break;
    case "error":
      body = <span><b className="font-medium">Couldn&apos;t update.</b> <span className="text-muted">{state.message}</span></span>;
      actions = (
        <>
          {later}
          <button type="button" onClick={() => void api().updates.download()} className="h-8 shrink-0 rounded-lg bg-btn2 px-3.5 font-medium text-btn2-ink">
            Try again
          </button>
        </>
      );
      break;
  }

  return (
    <div role="status" className="mx-2 mb-2 flex items-center gap-3 rounded-[10px] bg-panel px-3 py-2">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 items-center">{body}</div>
      {actions}
    </div>
  );
}
