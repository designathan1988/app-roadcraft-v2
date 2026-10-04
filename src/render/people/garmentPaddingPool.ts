import { padGarmentPixels, type GarmentPadRequest, type GarmentPadResponse } from './garmentPadding';

type Input = Omit<GarmentPadRequest, 'id'>;
interface Waiting {
  readonly input: Input;
  readonly resolve: (pixels: Uint8ClampedArray) => void;
  readonly reject: (error: unknown) => void;
}

const waiting = new Map<number, Waiting>();
let worker: Worker | null = null;
let unavailable = false;
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function padHere(job: Waiting): void {
  try {
    const { pixels, width, height, uvs, index, padding } = job.input;
    padGarmentPixels(pixels, width, height, uvs, index, padding);
    job.resolve(pixels);
  } catch (error) {
    job.reject(error);
  }
}

function clearIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
}

function idleSoon(): void {
  if (waiting.size || !worker) return;
  clearIdle();
  idleTimer = setTimeout(() => {
    if (waiting.size) return;
    worker?.terminate();
    worker = null;
    idleTimer = null;
  }, 30_000);
}

function failWorker(error: unknown): void {
  console.warn('Garment padding worker failed; finishing on the main thread.', error);
  unavailable = true;
  clearIdle();
  worker?.terminate();
  worker = null;
  for (const job of waiting.values()) padHere(job);
  waiting.clear();
}

function startWorker(): Worker | null {
  if (worker || unavailable) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    const created = new Worker(new URL('./garmentPadding.worker.ts', import.meta.url), { type: 'module' });
    created.onmessage = ({ data }: MessageEvent<GarmentPadResponse>) => {
      const job = waiting.get(data.id);
      if (!job) return;
      waiting.delete(data.id);
      if (data.pixels) job.resolve(data.pixels);
      else {
        console.warn('Garment padding worker rejected a texture; retrying on the main thread.', data.error);
        padHere(job);
      }
      idleSoon();
    };
    created.onerror = (event) => failWorker(event.message);
    created.onmessageerror = (event) => failWorker(event);
    worker = created;
    return created;
  } catch (error) {
    failWorker(error);
    return null;
  }
}

/** Runs pixel padding away from the frame loop, with the same algorithm as the fallback. */
export function padGarmentInWorker(input: Input): Promise<Uint8ClampedArray> {
  const active = startWorker();
  if (!active) {
    return new Promise((resolve, reject) => padHere({ input, resolve, reject }));
  }
  clearIdle();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const job = { input, resolve, reject };
    waiting.set(id, job);
    try {
      // Clone the source so the same bytes remain available if the worker fails.
      active.postMessage({ id, ...input });
    } catch (error) {
      waiting.delete(id);
      console.warn('Garment padding request could not be sent; retrying on the main thread.', error);
      padHere(job);
      idleSoon();
    }
  });
}
