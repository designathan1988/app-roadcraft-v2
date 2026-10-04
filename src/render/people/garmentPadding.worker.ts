import { padGarmentPixels, type GarmentPadRequest, type GarmentPadResponse } from './garmentPadding';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<GarmentPadRequest>) => void) | null;
  postMessage(message: GarmentPadResponse, transfer?: Transferable[]): void;
};

scope.onmessage = ({ data }) => {
  try {
    padGarmentPixels(data.pixels, data.width, data.height, data.uvs, data.index, data.padding);
    scope.postMessage({ id: data.id, pixels: data.pixels }, [data.pixels.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ id: data.id, error: String(error) });
  }
};
