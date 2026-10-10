import { distance, soundGain, makeWave } from './model';
import type { SoundProject, Source } from './model';

/** A real Web Audio graph; procedural sounds are local, deterministic buffers. */
export class SoundEngine {
  private context: AudioContext | null = null;
  private active: AudioBufferSourceNode[] = [];
  private nodes: { source: Source; gain: GainNode; panner: PannerNode }[] = [];
  private master: GainNode | null = null;
  private generation = 0;
  async start(p: SoundProject, offset = 0, speed = 1) {
    this.stop(); const generation = this.generation; this.context ??= new AudioContext(); await this.context.resume(); if (generation !== this.generation) return;
    const ctx = this.context, prepared: { source: Source; buffer: AudioBuffer }[] = [];
    for (const source of p.sources) { const buffer = await this.buffer(ctx, source); if (generation !== this.generation) return; prepared.push({ source, buffer }); }
    this.master = ctx.createGain(); this.master.gain.value = p.master; this.master.connect(ctx.destination);
    const starts: { node: AudioBufferSourceNode; offset: number }[] = [];
    for (const { source, buffer } of prepared) { const node = ctx.createBufferSource(); node.buffer = buffer; node.loop = source.loop; node.playbackRate.value = speed; const gain = ctx.createGain(), panner = ctx.createPanner(); gain.gain.value = distance(source, p.listener) > source.radius ? 0 : source.volume; panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = source.reference; panner.maxDistance = source.radius; panner.rolloffFactor = 1; panner.positionX.value = source.x; panner.positionZ.value = source.y; node.connect(gain).connect(panner).connect(this.master); this.nodes.push({ source, gain, panner }); if (source.loop || offset < buffer.duration) starts.push({ node, offset: source.loop ? offset % buffer.duration : offset }); }
    this.update(p); const startTime = ctx.currentTime + 0.02;
    for (const start of starts) { start.node.start(startTime, start.offset); this.active.push(start.node); }
  }
  setSpeed(speed: number) { for (const source of this.active) source.playbackRate.value = speed; }
  update(p: SoundProject) { const ctx = this.context; if (!ctx) return; ctx.listener.positionX.value = p.listener.x; ctx.listener.positionY.value = 0; ctx.listener.positionZ.value = p.listener.y; ctx.listener.forwardX.value = 0; ctx.listener.forwardY.value = 0; ctx.listener.forwardZ.value = -1; ctx.listener.upY.value = 1; if (this.master) this.master.gain.value = p.master;
    for (const n of this.nodes) { const source = p.sources.find(s => s.id === n.source.id); if (!source) continue; n.gain.gain.setTargetAtTime(distance(source, p.listener) > source.radius ? 0 : source.volume, ctx.currentTime, 0.03); n.panner.positionX.value = source.x; n.panner.positionY.value = 0; n.panner.positionZ.value = source.y; n.panner.refDistance = source.reference; n.panner.maxDistance = source.radius; }
  }
  stop() { this.generation++; for (const source of this.active) { source.stop(); source.disconnect(); } this.active = []; for (const n of this.nodes) { n.gain.disconnect(); n.panner.disconnect(); } this.nodes = []; this.master?.disconnect(); this.master = null; }
  private async buffer(ctx: BaseAudioContext, source: Source): Promise<AudioBuffer> {
    if (source.type === 'file' && source.audio) { const response = await fetch(source.audio); return ctx.decodeAudioData(await response.arrayBuffer()); }
    const rate = ctx.sampleRate, buffer = ctx.createBuffer(1, rate * 2, rate), samples = buffer.getChannelData(0); let seed = 9876;
    for (let i = 0; i < samples.length; i++) { const t = i / rate; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const noise = seed / 4294967296 * 2 - 1;
      samples[i] = source.type === 'motor' ? (Math.sin(t * source.frequency * Math.PI * 2) * 0.5 + Math.sin(t * source.frequency * Math.PI * 4) * 0.2 + noise * 0.08) : source.type === 'wind' ? noise * (0.18 + Math.sin(t * Math.PI * 2) * 0.05) : source.type === 'steps' ? noise * Math.exp(-((t * 2) % 1) * 25) * 0.8 : Math.sin(t * source.frequency * Math.PI * 2) * 0.5;
    } return buffer;
  }
  async exportWave(p: SoundProject): Promise<ArrayBuffer> {
    const rate = 44100, ctx = new OfflineAudioContext(2, Math.ceil(p.duration * rate), rate); ctx.listener.positionX.value = p.listener.x; ctx.listener.positionZ.value = p.listener.y;
    const master = ctx.createGain(); master.gain.value = p.master; master.connect(ctx.destination);
    for (const source of p.sources) { const node = ctx.createBufferSource(); node.buffer = await this.buffer(ctx, source); node.loop = source.loop; const gain = ctx.createGain(); const panner = ctx.createPanner(); gain.gain.value = soundGain(distance(source, p.listener), source.reference, source.radius, source.volume) === 0 ? 0 : source.volume; panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = source.reference; panner.maxDistance = source.radius; panner.positionX.value = source.x; panner.positionZ.value = source.y; node.connect(gain).connect(panner).connect(master); node.start(0); }
    const rendered = await ctx.startRendering(); return makeWave([rendered.getChannelData(0), rendered.getChannelData(1)], rate);
  }
}
