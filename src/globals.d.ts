/**
 * Compile-time keys, replaced by literals in the build (`vite.config.ts`
 * `define`) and in the test runner (`vitest.config.ts`). A file with no
 * import or export, so these are global.
 */

/** Walking the city as a person: weapons, shots, ragdolls, blood, blasts, destruction, Jolt. Off: none of it is bundled. */
declare const __PLAY_MODE__: boolean;
