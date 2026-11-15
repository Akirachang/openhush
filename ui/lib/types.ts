export type EngineErr = { message: string; details?: string; cancelled?: boolean };

export type HeavyStatus = { gpu: boolean; reason: string; installed: boolean; downloadGB: number };

export type Hello = {
  version: string;
  ffmpeg: { ok: boolean; message: string; details: string };
  engineReady: boolean;
  heavy: HeavyStatus;
  workers: number;
  previewSeconds: number;
  previewDir: string;
  supported: string[];
};

export type ProbeInfo = {
  path: string;
  name: string;
  kind: "audio" | "video";
  duration: number;
  codec: string;
  sampleRate: number;
  channels: number;
  label: string;
  sizeBytes: number;
};

export type PreviewResult = {
  original: string;
  cleaned: string;
  start: number;
  duration: number;
  strength: number;
  heavy: boolean;
};

export type FileStatus = "probing" | "ready" | "queued" | "running" | "done" | "failed" | "cancelled" | "invalid";

export type FileItem = {
  id: string;
  path: string;
  name: string;
  status: FileStatus;
  info?: ProbeInfo;
  progress?: number;
  message?: string;
  error?: EngineErr;
  output?: string;
  peaks?: number[];
  previewStart: number;
  jobStartedAt?: number;
};
