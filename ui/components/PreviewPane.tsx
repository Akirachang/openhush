"use client";
import { remove, reveal } from "@/lib/controller";
import { basename, fmtTime, stem } from "@/lib/format";
import { useStore } from "@/lib/store";
import Overview from "./Overview";
import Transport from "./Transport";
import Waveform from "./Waveform";

export default function PreviewPane() {
  const file = useStore((s) => s.files.find((f) => f.id === s.selectedId));
  const heavy = useStore((s) => s.heavy);
  const windowSec = useStore((s) => s.engine.hello?.previewSeconds ?? 15);

  if (!file) {
    return <div className="flex h-full items-center justify-center text-muted">Select a file to preview it.</div>;
  }

  const head = (
    <div className="flex flex-col gap-1.5">
      <span className="text-[20px] font-medium tracking-[-0.03em] text-muted">
        {file.info?.kind === "video" ? "Video preview" : file.info ? "Preview" : "Can't clean this file"}
      </span>
      <h1 className="selectable m-0 truncate text-[44px] font-semibold leading-none tracking-[-0.045em]">{stem(file.name)}</h1>
      <div aria-hidden="true" className="mt-2 h-[2px] w-11 bg-red" />
      {file.info && (
        <span className="label mt-1.5">
          {file.info.label} · {fmtTime(file.info.duration)}
        </span>
      )}
    </div>
  );

  if (!file.info) {
    return (
      <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 py-7">
        {head}
        {file.status === "probing" ? (
          <p className="text-muted">Reading the file…</p>
        ) : (
          <div className="flex max-w-[560px] flex-col gap-3">
            <p className="m-0 text-[15px] font-medium text-err">{file.error?.message}</p>
            {file.error?.details && (
              <pre className="selectable m-0 whitespace-pre-wrap rounded-lg bg-card p-3 font-mono text-[11px] text-muted">{file.error.details}</pre>
            )}
            <div>
              <button type="button" onClick={() => remove([file.id])} className="h-9 rounded-[10px] bg-btn2 px-3.5 text-btn2-ink">
                Remove from list
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-5 px-8 pb-24 pt-7">
      {head}
      {file.status === "done" && file.output && (
        <p className="m-0 -mt-2 text-[13px]">
          <span className="text-ok">Saved as {basename(file.output)}</span>{" "}
          <button type="button" onClick={() => reveal(file)} className="underline underline-offset-[3px]">
            Show in Finder
          </button>
        </p>
      )}
      {file.status === "failed" && file.error && (
        <p className="selectable m-0 -mt-2 text-[13px] text-err" title={file.error.details}>
          {file.error.message}
        </p>
      )}
      <Overview file={file} windowSec={windowSec} />
      <Waveform
        idleText={`Press play to hear ${Math.round(windowSec)} seconds, original vs. cleaned`}
        renderingText={heavy ? "Rendering with Heavy repair. This takes a few seconds…" : "Rendering preview…"}
      />
      <Transport />
    </div>
  );
}
