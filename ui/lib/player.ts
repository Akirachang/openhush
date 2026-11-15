// Gapless A/B player on the Web Audio API: both versions play in lockstep and only their gains change,
// so switching Original/Cleaned (or moving Mix) is instant and click-free at the same playhead.

const RAMP = 0.006; // seconds (time constant for gain changes)

export class ABPlayer {
  private ctx: AudioContext | null = null;
  private orig: AudioBuffer | null = null;
  private wet: AudioBuffer | null = null;
  private srcO: AudioBufferSourceNode | null = null;
  private srcW: AudioBufferSourceNode | null = null;
  private gO: GainNode | null = null;
  private gW: GainNode | null = null;
  private startedAt = 0;
  private offset = 0;
  playing = false;
  cleaned = true;
  mix = 1;

  private context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.gO = ctx.createGain();
      this.gW = ctx.createGain();
      this.gO.connect(ctx.destination);
      this.gW.connect(ctx.destination);
      this.ctx = ctx;
    }
    return this.ctx;
  }

  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.context().decodeAudioData(data);
  }

  get loaded(): boolean {
    return !!this.orig && !!this.wet;
  }

  get duration(): number {
    return this.orig?.duration ?? 0;
  }

  get position(): number {
    if (!this.playing || !this.ctx || !this.duration) return this.offset;
    const t = this.ctx.currentTime - this.startedAt + this.offset;
    return ((t % this.duration) + this.duration) % this.duration;
  }

  load(orig: AudioBuffer, wet: AudioBuffer, keepPosition: boolean) {
    const pos = keepPosition ? this.position : 0;
    const wasPlaying = this.playing;
    this.stopSources();
    this.playing = false;
    this.orig = orig;
    this.wet = wet;
    this.offset = Math.min(pos, Math.max(0, orig.duration - 0.05));
    if (wasPlaying && keepPosition) this.play();
  }

  unload() {
    this.pause();
    this.orig = this.wet = null;
    this.offset = 0;
  }

  play() {
    if (!this.orig || !this.wet) return;
    const ctx = this.context();
    void ctx.resume();
    this.stopSources();
    const make = (buf: AudioBuffer, gain: GainNode) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      return src;
    };
    this.srcO = make(this.orig, this.gO!);
    this.srcW = make(this.wet, this.gW!);
    const t = ctx.currentTime + 0.03;
    this.applyGains(true, t);
    this.srcO.start(t, this.offset);
    this.srcW.start(t, this.offset);
    this.startedAt = t;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position;
    this.stopSources();
    this.playing = false;
  }

  seek(seconds: number) {
    this.offset = Math.min(Math.max(0, seconds), Math.max(0, this.duration - 0.05));
    if (this.playing) this.play();
  }

  setCleaned(cleaned: boolean) {
    this.cleaned = cleaned;
    this.applyGains(false);
  }

  setMix(mix: number) {
    this.mix = Math.min(1, Math.max(0, mix));
    this.applyGains(false);
  }

  private applyGains(immediate: boolean, at?: number) {
    if (!this.ctx || !this.gO || !this.gW) return;
    const o = this.cleaned ? 1 - this.mix : 1;
    const w = this.cleaned ? this.mix : 0;
    const t = at ?? this.ctx.currentTime;
    for (const [node, v] of [[this.gO, o], [this.gW, w]] as const) {
      node.gain.cancelScheduledValues(t);
      if (immediate) node.gain.setValueAtTime(v, t);
      else node.gain.setTargetAtTime(v, t, RAMP);
    }
  }

  private stopSources() {
    for (const src of [this.srcO, this.srcW]) {
      if (!src) continue;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    }
    this.srcO = this.srcW = null;
  }
}

/** Loudness per bar (RMS of all channels), for drawing the preview waveform. */
export function barsOf(buf: AudioBuffer, n: number): number[] {
  const len = buf.length;
  const per = Math.max(1, Math.floor(len / n));
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const a = i * per;
    const b = Math.min(len, a + per);
    for (const ch of chans) for (let j = a; j < b; j += 4) sum += ch[j] * ch[j];
    out.push(Math.sqrt(sum / Math.max(1, ((b - a) / 4) * chans.length)));
  }
  return out;
}

export const player = new ABPlayer();
