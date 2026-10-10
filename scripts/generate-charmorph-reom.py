"""Generate Reom GLBs with CharMorph in headless Blender.

Usage:
  blender --background --factory-startup --python-exit-code 1 \
    --python scripts/generate-charmorph-reom.py -- \
    --addon-dir "C:/path/to/CharMorph" --out-dir exports/charmorph-reom --count 1

Omit --addon-dir when CharMorph is installed in this Blender version. The
CharMorph character library, including Reom, must be present in its data dir.
"""

import argparse
import importlib
import json
import random
import struct
import sys
from pathlib import Path

import bpy


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--addon-dir", type=Path, help="Directory containing CharMorph/__init__.py")
    parser.add_argument("--out-dir", type=Path, default=Path("exports/charmorph-reom"))
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    if args.count < 1:
        parser.error("--count must be at least 1")
    return args


def enable_charmorph(addon_dir):
    if addon_dir:
        addon_dir = addon_dir.resolve()
        if addon_dir.name != "CharMorph" or not (addon_dir / "__init__.py").is_file():
            raise RuntimeError(f"Expected CharMorph/__init__.py in --addon-dir: {addon_dir}")
        sys.path.insert(0, str(addon_dir.parent))
        addon = importlib.import_module("CharMorph")
        addon.register()
    else:
        import addon_utils

        addon = addon_utils.enable("CharMorph", default_set=False, persistent=False)
        if addon is None:
            raise RuntimeError("CharMorph is not installed for this Blender version; pass --addon-dir")
    from CharMorph.lib.charlib import library

    reom = next((name for name in library.chars if name.casefold() == "reom"), None)
    if reom is None:
        raise RuntimeError(
            f"Reom is missing from CharMorph library at {library.dirpath}; "
            f"available bases: {sorted(library.chars)}. Install the Reom character data."
        )
    return reom, library.chars[reom]


def generate_one(base_name, index, seed, out_dir):
    from CharMorph.common import manager

    rng = random.Random(seed + index)
    ui = bpy.context.window_manager.charmorph_ui
    ui.base_model = base_name
    ui.import_morphs = False
    ui.import_expressions = False
    before = set(bpy.data.objects)
    result = bpy.ops.charmorph.import_char()
    if result != {"FINISHED"}:
        raise RuntimeError(f"CharMorph import failed: {result}")
    created = set(bpy.data.objects) - before
    obj = bpy.context.view_layer.objects.active
    if obj is None or obj.type != "MESH" or obj not in created:
        raise RuntimeError("CharMorph did not create an active Reom mesh")

    morpher = manager.morpher
    if not morpher or morpher.error:
        raise RuntimeError(f"CharMorph morpher unavailable: {getattr(morpher, 'error', None)}")
    baseline = [tuple(vertex.co) for vertex in obj.data.vertices]
    available = sorted(
        (m for m in morpher.core.morphs_l2
         if getattr(m, "name", None) and max(m.min, -0.25) < min(m.max, 0.25)),
        key=lambda m: m.name,
    )
    # Vary a small, deterministic subset rather than every slider at once.
    chosen = rng.sample(available, min(4, len(available)))
    morph_values = {}
    for morph in chosen:
        low = max(morph.min, -0.25)
        high = min(morph.max, 0.25)
        value = round(rng.uniform(low, high), 4)
        morpher.core.prop_set(morph.name, value)
        morph_values[morph.name] = value
    if morph_values:
        morpher.update()
    changed_vertices = sum(
        any(abs(a - b) > 1e-6 for a, b in zip(vertex.co, baseline[i]))
        for i, vertex in enumerate(obj.data.vertices)
    )
    if morph_values and changed_vertices == 0:
        raise RuntimeError("Morph values were set, but the Reom mesh did not change")

    bpy.ops.object.select_all(action="DESELECT")
    for item in created:
        item.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path = out_dir / f"reom_{index:03d}.glb"
    result = bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True,
        export_animations=False, export_morph=False,
    )
    if result != {"FINISHED"}:
        raise RuntimeError(f"GLB export failed: {result}")
    with path.open("rb") as stream:
        header = stream.read(12)
    magic, version, length = struct.unpack("<4sII", header)
    if (magic, version, length) != (b"glTF", 2, path.stat().st_size):
        raise RuntimeError(f"Invalid GLB header: {path}")
    return {
        "file": path.name,
        "bytes": path.stat().st_size,
        "vertices": len(obj.data.vertices),
        "faces": len(obj.data.polygons),
        "changed_vertices": changed_vertices,
        "morphs": morph_values,
    }


def main():
    args = arguments()
    base_name, character = enable_charmorph(args.addon_dir)
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    generated = [generate_one(base_name, i, args.seed, out_dir) for i in range(args.count)]
    manifest = {
        "generator": "CharMorph + Reom",
        "blender": bpy.app.version_string,
        "seed": args.seed,
        "source_author": character.author,
        "source_license": getattr(character, "license", getattr(character, "licence", "")),
        "characters": generated,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("Generated:", json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
