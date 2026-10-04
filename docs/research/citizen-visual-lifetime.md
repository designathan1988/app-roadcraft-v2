# Citizen visual lifetime: performance audit

## Sources

- [three.js: WebGLRenderer.info](https://threejs.org/docs/pages/WebGLRenderer.html) reports live geometry and texture allocations and render calls. These counters accompany browser heap and frame profiles here.
- [three.js: disposing objects](https://threejs.org/manual/pages/how-to-dispose-of-objects.html) requires explicit disposal of geometry, materials, textures, skeletons, and render targets; removing scene objects alone does not release GPU resources.
- [three.js: InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html) reduces draw calls for repeated meshes. Roadcraft already uses instanced, palette-skinned citizens, so replacing it with individual `SkinnedMesh` objects would raise draw calls.
- [three.js: KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html) supports GPU-compressed textures, but requires a transcoder and a cooked asset path. The measured dominant waste was unused character models and animation arrays, so texture conversion is deferred pending a texture-specific profile.
- [Unreal Mass Gameplay](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-mass-gameplay-in-unreal-engine) separates simulation LOD from visual representation and supports a visual `Off` state. This matches Roadcraft's existing simulation/render boundary.
- [NVIDIA GPU Gems 3: Animated Crowd Rendering](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-2-animated-crowd-rendering) combines instancing with LOD for animated crowds; Roadcraft already follows this approach for drawn citizens.
- [Chrome DevTools performance reference](https://developer.chrome.com/docs/devtools/performance/reference) separates network requests from main-thread work in startup traces. Source-mapped CPU samples identified synchronous texture, topology and scene-build costs after the JavaScript download.
- [MDN: JavaScript remainder](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Remainder) explains the double-remainder expression used to wrap negative coordinates in the texture baker. Normal-map neighbours can be wrapped once at each row or edge without changing any sampled pixel.

## Findings and decision

`createRiggedCitizens` requested all 84 character models shortly after startup, regardless of whether a person was visible. Empty batches did not draw, but retained geometries, materials, bone palettes, and baked animation arrays. In the town after 30 seconds, the baseline used 84 models and 395 MiB of animation data. Loading an empty map left those resources allocated.

Keep logical people in `sim`; request visual batches only when the renderer actually needs a visible walker, rider, passenger, or indoor figure. Retain recently used batches for a return pan, then dispose inactive batches and cancel their pending texture uploads. Continue using the existing instancing and LOD path for active batches. This changes resource lifetime without changing simulation state or the visual algorithm for a drawn person.
