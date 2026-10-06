"""Convert a human base model into the generator's pack (`public/models/humans/<base>/`).

Usage (Blender 5.x, no window):
  blender -b --factory-startup --python scripts/build-human-base.py -- \
    --base vitruvian --src <CharMorph-Vitruvian checkout> [--tex 2048]
  blender -b --factory-startup --python scripts/build-human-base.py -- \
    --base mhr --src <MHR assets folder with lod1.fbx>

Bases:
  vitruvian  CharMorph's Vitruvian: `char.blend` (mesh, UVs), `morphs/L1/Default.npy`
             (the basis), `morphs/L2` (body and face sliders, `morphs.json` gives
             the order and ranges), `morphs/L3` (expressions), `textures/4K/*.exr`
             (UDIM tiles 1001..1008).
  mhr        Meta's Momentum Human Rig, `lod1.fbx`: 45 identity shape keys
             (20 body, 20 head, 5 hands, unit normal) and 72 expression keys.

Output, all in metres, three.js frame (+Y up, the body faces +Z):
  base.json  sections of base.bin, draw groups, the morph table, textures
  base.bin   positions (float32, one per mesh vertex), render vertices (source
             vertex uint32 + uv float32 each; a vertex on a UV seam is several
             render vertices), triangle indices (uint32), morph entries (vertex
             uint32 + delta int16 x3, scaled per morph)
  *.jpg      textures, one per map and UDIM tile
"""

import argparse
import json
import os
import sys
from pathlib import Path

import bpy
import numpy as np


def arguments():
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True, choices=["vitruvian", "mhr"])
    p.add_argument("--src", required=True, type=Path)
    p.add_argument("--out", type=Path, default=None)
    p.add_argument("--tex", type=int, default=2048, help="texture size per UDIM tile")
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def to_three(v):
    """Blender (+Z up, the body faces -Y) to three.js (+Y up, the body faces +Z)."""
    v = np.asarray(v, dtype=np.float64)
    return np.stack([v[..., 0], v[..., 2], -v[..., 1]], axis=-1)


def mesh_loops(me, uv_name):
    """Per face: loop start, loop count, material; per loop: vertex, uv."""
    n = len(me.polygons)
    ls = np.zeros(n, np.int64); me.polygons.foreach_get("loop_start", ls)
    lt = np.zeros(n, np.int64); me.polygons.foreach_get("loop_total", lt)
    mi = np.zeros(n, np.int64); me.polygons.foreach_get("material_index", mi)
    lv = np.zeros(len(me.loops), np.int64); me.loops.foreach_get("vertex_index", lv)
    attr = me.attributes[uv_name]
    uv = np.zeros(len(attr.data) * 2, np.float32); attr.data.foreach_get("vector", uv)
    return ls, lt, mi, lv, uv.reshape(-1, 2)


def build_render_mesh(positions, ls, lt, mi, lv, uv):
    """Triangles grouped by (material, UDIM tile), seam vertices split by UV."""
    corners_v, corners_uv, tri_group = [], [], []
    tri_corners = []
    for f in range(len(ls)):
        s, c = ls[f], lt[f]
        loops = list(range(s, s + c))
        fuv = uv[s:s + c]
        tile = int(np.floor(fuv[:, 0].mean()))
        if c == 4:
            a, b, cc, d = (positions[lv[l]] for l in loops)
            # Split a quad along its shorter diagonal.
            tris = [(0, 1, 2), (0, 2, 3)] if np.linalg.norm(a - cc) <= np.linalg.norm(b - d) else [(0, 1, 3), (1, 2, 3)]
        else:
            tris = [(0, i, i + 1) for i in range(1, c - 1)]
        for t in tris:
            tri_corners.append([loops[i] for i in t])
            tri_group.append((int(mi[f]), tile))
    tri_corners = np.array(tri_corners, np.int64)
    # One render vertex per distinct (vertex, uv).
    key_v = lv
    key_u = np.round(uv[:, 0] * 1e5).astype(np.int64)
    key_w = np.round(uv[:, 1] * 1e5).astype(np.int64)
    keys = np.stack([key_v, key_u, key_w], 1)
    uniq, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    r_src = lv[first].astype(np.uint32)
    r_uv = uv[first].astype(np.float32)
    # Tile offset removed: every group samples its own tile's 0..1 texture.
    r_uv[:, 0] -= np.floor(r_uv[:, 0] - 1e-6).clip(min=0)
    tris = inverse[tri_corners]
    order = sorted(range(len(tris)), key=lambda i: tri_group[i])
    tris = tris[order]
    groups = []
    for i in order:
        g = tri_group[i]
        if groups and groups[-1]["key"] == g:
            groups[-1]["count"] += 3
        else:
            groups.append({"key": g, "start": (groups[-1]["start"] + groups[-1]["count"]) if groups else 0, "count": 3})
    return r_src, r_uv, tris.astype(np.uint32).reshape(-1), groups


class Pack:
    def __init__(self):
        self.chunks, self.sections, self.offset = [], [], 0

    def add(self, name, array, item_size=1):
        a = np.ascontiguousarray(array)
        pad = (-self.offset) % 4
        if pad:
            self.chunks.append(b"\0" * pad); self.offset += pad
        self.sections.append({"name": name, "type": a.dtype.name, "itemSize": item_size,
                              "count": int(a.size // item_size), "byteOffset": self.offset})
        self.chunks.append(a.tobytes()); self.offset += a.nbytes

    def bytes(self):
        return b"".join(self.chunks)


def quantize_morphs(morphs, pack):
    """morphs: list of (name, group, min, max, idx uint, delta float [n,3] in three frame)."""
    table, all_idx, all_delta, start = [], [], [], 0
    for name, group, lo, hi, idx, delta in morphs:
        keep = np.abs(delta).max(1) > 1e-6
        idx, delta = idx[keep], delta[keep]
        m = float(np.abs(delta).max()) if len(delta) else 0.0
        scale = m / 32767 if m > 0 else 1.0
        q = np.round(delta / scale).astype(np.int16)
        table.append({"name": name, "group": group, "min": lo, "max": hi, "start": start,
                      "count": int(len(idx)), "scale": scale,
                      "maxQuantError": float(np.abs(q * scale - delta).max()) if len(delta) else 0.0})
        all_idx.append(idx.astype(np.uint32)); all_delta.append(q)
        start += len(idx)
    pack.add("morphIndex", np.concatenate(all_idx))
    pack.add("morphDelta", np.concatenate(all_delta).reshape(-1), 3)
    return table


def write(out, meta, pack):
    out.mkdir(parents=True, exist_ok=True)
    meta["sections"] = pack.sections
    (out / "base.bin").write_bytes(pack.bytes())
    (out / "base.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote {out} ({pack.offset / 1e6:.1f} MB)")


def save_texture(src, dst, size, colour):
    """EXR tile -> JPEG. Colour maps are encoded sRGB, data maps stay linear."""
    img = bpy.data.images.load(str(src))
    img.colorspace_settings.name = "Non-Color"
    w, h = img.size
    if w != size:
        img.scale(size, size)
    px = np.zeros(size * size * 4, np.float32); img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    rgb = np.clip(px[:, :3], 0, 1)
    if colour:
        rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
    px[:, :3] = rgb; px[:, 3] = 1
    out = bpy.data.images.new(dst.stem, size, size, alpha=False)
    out.colorspace_settings.name = "Non-Color"
    out.pixels.foreach_set(px.reshape(-1))
    out.filepath_raw = str(dst); out.file_format = "JPEG"
    bpy.context.scene.render.image_settings.quality = 90
    out.save()
    bpy.data.images.remove(img); bpy.data.images.remove(out)
    print("  texture", dst.name, f"{w}->{size}")


def vitruvian(src: Path, out: Path, tex: int):
    bpy.ops.wm.open_mainfile(filepath=str(src / "char.blend"))
    obj = bpy.data.objects["cm_vitruvian"]
    # The file was saved in edit mode: the evaluated mesh holds the loop data.
    me = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    basis_b = np.load(src / "morphs/L1/Default.npy").astype(np.float64)
    blend_co = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get("co", blend_co)
    drift = np.abs(blend_co.reshape(-1, 3) - basis_b).max()
    print("basis vs blend vertex order, max drift (m):", drift)
    assert drift < 0.05, "Default.npy is not in the mesh's vertex order"
    positions = to_three(basis_b)
    ls, lt, mi, lv, uv = mesh_loops(me, "VitruvianUV.UDIM")
    r_src, r_uv, index, groups = build_render_mesh(positions, ls, lt, mi, lv, uv)
    # Slot order is CharMorph's `materials` list in config.yaml.
    names = ["Iris", "Mouth", "Pupil", "Sclera_Cornea", "Skin", "Covered", "EyeHair", "Tearline"]
    for g in groups:
        g["material"] = names[g["key"][0]]; g["tile"] = 1001 + g["key"][1]; del g["key"]

    morphs = []
    order = json.loads((src / "morphs/L2/morphs.json").read_text())
    for item in order:
        name = item.get("morph")
        if not name:
            continue
        f = next((src / "morphs/L2" / (name + e) for e in (".npz", ".npy") if (src / "morphs/L2" / (name + e)).exists()), None)
        if f is None:
            print("  missing L2", name); continue
        idx, delta = load_morph(f)
        group = name.split("_", 1)[0]
        morphs.append((name, group, item.get("min", 0), item.get("max", 1), idx, to_three(delta)))
    for f in sorted((src / "morphs/L3").glob("*.np[yz]")):
        idx, delta = load_morph(f)
        morphs.append((f.stem, "Expression", 0, 1, idx, to_three(delta)))

    pack = Pack()
    pack.add("positions", positions.astype(np.float32).reshape(-1), 3)
    pack.add("renderSource", r_src)
    pack.add("renderUv", r_uv.reshape(-1), 2)
    pack.add("index", index)
    # Where the eye's outer shell is clear cornea rather than white sclera.
    cornea = np.zeros(len(me.vertices) * 4, np.float32)
    me.attributes["CorneaCol"].data.foreach_get("color", cornea)
    pack.add("corneaMask", (cornea.reshape(-1, 4)[:, 0].clip(0, 1) * 255).round().astype(np.uint8))
    table = quantize_morphs(morphs, pack)

    textures = {}
    maps = {"Light_Skin_Color": True, "Dark_Skin_Color": True, "Skin_Roughness": False, "Skin_Height": False,
            "Skin_Age_Height": False, "Sclera_Color": True, "Sclera_Height": False, "Iris_Color": True,
            "Iris_Height": False, "Iris_Roughness": False, "Mouth_Color": True, "Mouth_Roughness": False,
            "Mouth_Height": False}
    out.mkdir(parents=True, exist_ok=True)
    for exr in sorted((src / "textures/4K").glob("*.exr")):
        stem, tile = exr.stem.rsplit(".", 1)
        if stem not in maps:
            continue
        dst = out / f"{stem}.{tile}.jpg"
        save_texture(exr, dst, tex, maps[stem])
        textures.setdefault(stem, []).append(int(tile))

    write(out, {"format": "roadcraft-humans/1", "base": "vitruvian", "units": "metres, +Y up, faces +Z",
                "vertexCount": int(len(positions)), "renderVertexCount": int(len(r_src)),
                "groups": groups, "morphs": table, "textures": textures}, pack)


def load_morph(f: Path):
    z = np.load(f)
    if isinstance(z, np.ndarray):
        d = z.astype(np.float64)
        return np.arange(len(d), dtype=np.uint32), d
    return z["idx"].astype(np.uint32), z["delta"].astype(np.float64)


def mhr(src: Path, out: Path, _tex: int):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(src / "lod1.fbx"))
    obj = next(o for o in bpy.data.objects if o.type == "MESH")
    me = obj.data
    mw = np.array(obj.matrix_world)
    keys = me.shape_keys.key_blocks
    n = len(me.vertices)

    def world(k):
        co = np.zeros(n * 3); k.data.foreach_get("co", co)
        co = co.reshape(-1, 3)
        return co @ mw[:3, :3].T + mw[:3, 3]

    basis = world(keys[0])
    positions = to_three(basis)
    uv_name = next(a.name for a in me.attributes if a.domain == "CORNER" and a.data_type == "FLOAT2")
    ls, lt, mi, lv, uv = mesh_loops(me, uv_name)
    r_src, r_uv, index, groups = build_render_mesh(positions, ls, lt, mi, lv, uv)
    for g in groups:
        g["material"] = "Skin"; g["tile"] = 1001; del g["key"]
    morphs = []
    for i, k in enumerate(keys[1:]):
        d = to_three(world(k)) - positions
        if i < 20: group = "Body"
        elif i < 40: group = "Head"
        elif i < 45: group = "Hands"
        else: group = "Expression"
        lo, hi = (-3, 3) if i < 45 else (0, 1)
        morphs.append((k.name, group, lo, hi, np.arange(n, dtype=np.uint32), d))
    print("shape keys:", [k.name for k in keys][:5], "...", [k.name for k in keys][-5:])
    pack = Pack()
    pack.add("positions", positions.astype(np.float32).reshape(-1), 3)
    pack.add("renderSource", r_src)
    pack.add("renderUv", r_uv.reshape(-1), 2)
    pack.add("index", index)
    table = quantize_morphs(morphs, pack)
    write(out, {"format": "roadcraft-humans/1", "base": "mhr", "units": "metres, +Y up, faces +Z",
                "vertexCount": int(n), "renderVertexCount": int(len(r_src)), "groups": groups,
                "morphs": table, "textures": {}}, pack)


def main():
    a = arguments()
    out = a.out or Path(__file__).resolve().parent.parent / "public/models/humans" / a.base
    {"vitruvian": vitruvian, "mhr": mhr}[a.base](a.src.resolve(), out.resolve(), a.tex)


main()
