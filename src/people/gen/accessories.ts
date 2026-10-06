/** Face accessories the creator offers: glasses and earrings (drawn by `render/people/generator/accessories.ts`). */

export interface GlassesParams { readonly style: string; readonly colour: number; readonly tint: number; readonly tintAmount: number }
export interface EarringParams { readonly style: string; readonly colour: number }
export interface Accessories { readonly glasses: GlassesParams; readonly earrings: EarringParams }

export const GLASSES_STYLES = ['none', 'round', 'square', 'cat', 'aviator'] as const;
export const EARRING_STYLES = ['none', 'studs', 'hoops'] as const;
export const FRAME_COLOURS: readonly number[] = [0x111111, 0x5a3a24, 0x8a6a3a, 0xc8a24a, 0xb8b8b8, 0x7a1f2a, 0x2b3a5c, 0xe6e2da];
export const LENS_TINTS: readonly number[] = [0xffffff, 0x3a3a3a, 0x5a3d2b, 0x2f5a3a, 0x2b3a5c, 0xc23a32];
export const METALS: readonly number[] = [0xd4af37, 0xc0c0c0, 0xb87333, 0xe5e4e2];

export const NO_ACCESSORIES: Accessories = {
  glasses: { style: 'none', colour: 0x111111, tint: 0xffffff, tintAmount: 0 },
  earrings: { style: 'none', colour: 0xd4af37 },
};
