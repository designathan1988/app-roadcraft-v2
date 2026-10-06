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
  --mhr DIR  (vitruvian) also carry the MHR's 45 identity components onto the
             Vitruvian mesh as morphs `MHR_<Body|Head|Hands>_NN` (see
             `mhr_shape_morphs`).
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
    p.add_argument("--keep-textures", action="store_true", help="vitruvian: reuse the JPEGs already in the output folder")
    p.add_argument("--mhr", type=Path, default=None, help="vitruvian: MHR assets folder; adds MHR's 45 shape components")
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


def box_blur(a, r):
    """Mean over a (2r+1) square, edges clamped; three passes approach a Gaussian."""
    r = max(1, int(round(r)))
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]; pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis)
        hi = np.take(c, range(2 * r + 1, c.shape[axis]), axis=axis)
        lo = np.take(c, range(0, c.shape[axis] - 2 * r - 1), axis=axis)
        a = (hi - lo) / (2 * r + 1)
    return a


def gauss(a, sigma):
    r = sigma * 0.9  # three box passes of this half-width ~ a Gaussian of `sigma`
    for _ in range(3):
        a = box_blur(a, r)
    return a


def face_guard(size):
    """
    0 over the face tile's features (eyes, nose, mouth, ears: an ellipse in
    the tile's middle), 1 over the neck, the sides and the scalp, soft between.
    """
    y, x = np.mgrid[0:size, 0:size] / size
    # Blender's pixel rows run bottom-up: the face's middle sits at v = 0.52.
    d = np.hypot((x - 0.5) / 0.47, (y - 0.52) / 0.36)
    return np.clip((d - 0.9) / 0.25, 0, 1)


def even_out(rgb, size, guard=None):
    """
    Frequency separation of the albedo's brightness, as in photogrammetry
    delighting: the mid band (blotches a few centimetres across, baked
    shading and uneven capture light, which Cycles' subsurface scattering
    hides but a real-time shader shows) is weakened by 70%; pores, freckles
    and the broad tone are kept, and the colour (chroma) is untouched.
    """
    img = rgb.reshape(size, size, 3)
    lum = np.log(img @ np.array([0.2126, 0.7152, 0.0722]) + 1e-4)
    s = size / 2048
    mid = gauss(lum, 6 * s) - gauss(lum, 96 * s)
    before = float(mid.std())
    strength = 0.7 if guard is None else 0.7 * guard
    img = img * np.exp(-strength * mid)[..., None]
    print(f"    blotch band std {before:.4f} -> {before * 0.3:.4f}")
    return np.clip(img.reshape(-1, 3), 0, 1)


def save_texture(src, dst, size, colour, even=False, guard=False):
    """EXR tile -> JPEG. Colour maps are encoded sRGB, data maps stay linear."""
    img = bpy.data.images.load(str(src))
    img.colorspace_settings.name = "Non-Color"
    w, h = img.size
    if w != size:
        img.scale(size, size)
    px = np.zeros(size * size * 4, np.float32); img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    rgb = np.clip(px[:, :3], 0, 1)
    if even:
        rgb = even_out(rgb, size, face_guard(size) if guard else None)
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


def vitruvian(src: Path, out: Path, tex: int, mhr_dir: Path | None = None, keep_textures=False):
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
    # Where the eye's outer shell is clear cornea rather than white sclera.
    # (Read now: importing the MHR later frees this evaluated mesh.)
    col = np.zeros(len(me.vertices) * 4, np.float32)
    me.attributes["CorneaCol"].data.foreach_get("color", col)
    cornea = (col.reshape(-1, 4)[:, 0].clip(0, 1) * 255).round().astype(np.uint8)
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
    if mhr_dir:
        vert_material = np.empty(len(positions), object)
        for f in range(len(ls)):
            vert_material[lv[ls[f]:ls[f] + lt[f]]] = names[mi[f]]
        e = []
        for f in range(len(ls)):
            ring = lv[ls[f]:ls[f] + lt[f]]
            e.append(np.stack([ring, np.roll(ring, -1)], 1))
        edges = np.unique(np.sort(np.concatenate(e), 1), axis=0)
        morphs += mhr_shape_morphs(src, mhr_dir, positions, vert_material, edges)

    pack = Pack()
    pack.add("positions", positions.astype(np.float32).reshape(-1), 3)
    pack.add("renderSource", r_src)
    pack.add("renderUv", r_uv.reshape(-1), 2)
    pack.add("index", index)
    pack.add("corneaMask", cornea)
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
        if not (keep_textures and dst.exists()):
            # The skin tiles are evened out; on the face tile (1001) only the
            # neck, sides and scalp, the lips, brows, nose and ears as painted.
            save_texture(exr, dst, tex, maps[stem], even=stem.endswith("Skin_Color"), guard=tile == "1001")
        textures.setdefault(stem, []).append(int(tile))

    write(out, {"format": "roadcraft-humans/1", "base": "vitruvian", "units": "metres, +Y up, faces +Z",
                "vertexCount": int(len(positions)), "renderVertexCount": int(len(r_src)),
                "groups": groups, "morphs": table, "textures": textures}, pack)


def segments():
    """
    Body parts both rigs share: (name, Vitruvian start and end joints,
    Vitruvian deform bones, MHR start and end joints, MHR vertex groups).
    The MHR joints are its bones' heads; `+toe` is a point 6 cm past the
    ball along the foot.
    """
    segs = [
        ("pelvis", "spine_head", "spine_tail", ["DEF-spine", "DEF-pelvis.L", "DEF-pelvis.R"], "root", "c_spine1", ["root", "c_spine0"]),
        ("abdomen", "spine_tail", "spine.001_tail", ["DEF-spine.001", "DEF-abdomen", "DEF-abdomen.001"], "c_spine1", "c_spine2", ["c_spine0", "c_spine1", "c_spine2"]),
        ("chest", "spine.001_tail", "spine.004_head", ["DEF-spine.002", "DEF-spine.003", "DEF-breast.L", "DEF-breast.R", "DEF-chest_expand"], "c_spine2", "c_neck", ["c_spine2", "c_spine3"]),
        ("neck", "spine.004_head", "spine.005_tail", ["DEF-spine.004", "DEF-spine.005"], "c_neck", "c_head", ["c_neck_twist1_proc"]),
        ("head", "spine.005_tail", "spine.006_tail", ["DEF-spine.006"], "c_head", "c_head_null", ["c_head", "c_jaw"]),
    ]
    for S, m in (("L", "l"), ("R", "r")):
        segs += [
            ("clavicle" + S, f"shoulder.{S}_head", f"shoulder.{S}_tail", [f"DEF-shoulder.{S}"], f"{m}_clavicle", f"{m}_uparm", [f"{m}_clavicle"]),
            ("upperarm" + S, f"upper_arm.{S}_head", f"upper_arm.{S}_tail", [f"DEF-upper_arm.{S}", f"DEF-upper_arm.{S}.001"],
             f"{m}_uparm", f"{m}_lowarm", [f"{m}_uparm_twist{i}_proc" for i in range(5)]),
            ("forearm" + S, f"upper_arm.{S}_tail", f"forearm.{S}_tail", [f"DEF-forearm.{S}", f"DEF-forearm.{S}.001"],
             f"{m}_lowarm", f"{m}_wrist", [f"{m}_lowarm_twist{i}_proc" for i in range(1, 5)] + [f"{m}_wrist_twist"]),
            ("hand" + S, f"forearm.{S}_tail", f"f_middle.01.{S}_head", [f"DEF-hand.{S}"] + [f"DEF-palm.0{i}.{S}" for i in range(1, 5)],
             f"{m}_wrist", f"{m}_middle1", [f"{m}_wrist", f"{m}_pinky0"]),
            ("thigh" + S, f"thigh.{S}_head", f"thigh.{S}_tail", [f"DEF-thigh.{S}", f"DEF-thigh.{S}.001", f"DEF-thigh-lateral.{S}", f"DEF-thigh-medial.{S}"],
             f"{m}_upleg", f"{m}_lowleg", [f"{m}_upleg_twist{i}_proc" for i in range(1, 5)]),
            ("shin" + S, f"thigh.{S}_tail", f"shin.{S}_tail", [f"DEF-shin.{S}", f"DEF-shin.{S}.001", f"DEF-knee.{S}"],
             f"{m}_lowleg", f"{m}_talocrural", [f"{m}_lowleg"] + [f"{m}_lowleg_twist{i}_proc" for i in range(1, 5)]),
            ("foot" + S, f"shin.{S}_tail", f"foot.{S}_tail", [f"DEF-foot.{S}"],
             f"{m}_talocrural", f"{m}_ball", [f"{m}_talocrural", f"{m}_subtalar", f"{m}_transversetarsal"]),
            ("toes" + S, f"foot.{S}_tail", f"toe.{S}_tail", [f"DEF-toe_bend.{S}", f"DEF-big_toe.01.{S}", f"DEF-big_toe.02.{S}"],
             f"{m}_ball", f"{m}_ball+toe", [f"{m}_ball"]),
        ]
        for vf, mf in (("index", "index"), ("middle", "middle"), ("ring", "ring"), ("pinky", "pinky"), ("thumb", "thumb")):
            vbone = (lambda k: f"thumb.0{k}.{S}") if vf == "thumb" else (lambda k, vf=vf: f"f_{vf}.0{k}.{S}")
            for k in (1, 2, 3):
                start = f"{vbone(1)}_head" if k == 1 else f"{vbone(k - 1)}_tail"
                mend = f"{m}_{mf}{k + 1}" if k < 3 else f"{m}_{mf}_null"
                groups = [f"{m}_{mf}{k}"] + ([f"{m}_{mf}_null"] if k == 3 else [])
                segs.append((f"{vf}{k}{S}", start, f"{vbone(k)}_tail", [f"DEF-{vbone(k)}"], f"{m}_{mf}{k}", mend, groups))
    return segs


def frame(a, b):
    """Origin, rotation (columns: along the bone, then two across) and length of a segment."""
    axis = b - a
    length = float(np.linalg.norm(axis))
    e1 = axis / length
    ref = np.array([0.0, 0.0, 1.0]) if abs(e1[2]) < 0.8 else np.array([0.0, 1.0, 0.0])
    e2 = ref - ref.dot(e1) * e1
    e2 /= np.linalg.norm(e2)
    return a, np.stack([e1, e2, np.cross(e1, e2)], 1), length


def knn(points, queries, k):
    """The k nearest of `points` to every query, by blocks of distance matrices (BLAS), no Python loop per point."""
    pp = (points * points).sum(1)
    idx = np.empty((len(queries), k), np.int64)
    dist = np.empty((len(queries), k))
    for s in range(0, len(queries), 2048):
        q = queries[s:s + 2048]
        d2 = (q * q).sum(1)[:, None] - 2 * (q @ points.T) + pp[None, :]
        i = np.argpartition(d2, k, axis=1)[:, :k]
        idx[s:s + len(q)] = i
        dist[s:s + len(q)] = np.sqrt(np.maximum(np.take_along_axis(d2, i, 1), 0))
    return idx, dist


def mhr_shape_morphs(vit_src: Path, mhr_dir: Path, positions, vert_material, edges):
    """
    MHR's 45 identity components carried onto the Vitruvian mesh, as Meta's
    own SMPL<->MHR tool carries a body between topologies (a surface mapping
    then interpolation), with the two rigs' differing poses taken out: each
    Vitruvian vertex is put into the frame of its body part's bone, scaled
    along the bone to the MHR's length, found on the same part of the MHR,
    and the MHR's deltas there are turned from the MHR bone's frame into the
    Vitruvian's. Parts are blended by the Vitruvian's skin weights, so a
    vertex between two bones takes both. The eyes and the mouth's inside
    move as one piece (the MHR has none), so no eye is squashed.
    """
    bpy.ops.import_scene.fbx(filepath=str(mhr_dir / "lod1.fbx"))
    arm = next(o for o in bpy.context.selected_objects if o.type == "ARMATURE")
    mobj = next(o for o in bpy.context.selected_objects if o.type == "MESH")
    mw = np.array(mobj.matrix_world)
    keys = mobj.data.shape_keys.key_blocks
    n_m = len(mobj.data.vertices)

    def world(k):
        co = np.zeros(n_m * 3); k.data.foreach_get("co", co)
        return to_three(co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3])

    m_basis = world(keys[0])
    m_delta = np.stack([world(keys[1 + i]) - m_basis for i in range(45)], 1)  # [n_m, 45, 3]
    aw = np.array(arm.matrix_world)
    m_joint = {b.name: to_three(aw[:3, :3] @ np.array(b.head_local) + aw[:3, 3]) for b in arm.data.bones}
    for s in ("l", "r"):
        ball, mid = m_joint[f"{s}_ball"], m_joint[f"{s}_transversetarsal"]
        m_joint[f"{s}_ball+toe"] = ball + 0.06 * (ball - mid) / np.linalg.norm(ball - mid)
    m_w = np.zeros((n_m, len(mobj.vertex_groups)), np.float32)
    for v in mobj.data.vertices:
        for g in v.groups:
            m_w[v.index, g.group] = g.weight
    m_group = {g.name: g.index for g in mobj.vertex_groups}

    # The Vitruvian's joints are weighted means of its vertices (CharMorph's
    # joints/*.npz), and its skin weights come from weights/rigify.npz.
    def npz_groups(f):
        z = np.load(f)
        names = [x.decode() for x in bytes(z["names"]).split(b"\0")]
        i = 0
        for name, c in zip(names, z["cnt"]):
            c = int(c)
            yield name, z["idx"][i:i + c].astype(np.int64), z["weights"][i:i + c].astype(np.float64)
            i += c
    v_joint = {}
    for name, idx, w in npz_groups(vit_src / "joints/rigify.npz"):
        v_joint[name[len("joint_"):]] = (positions[idx] * w[:, None]).sum(0) / w.sum()
    n_v = len(positions)
    v_bone = {}
    for name, idx, w in npz_groups(vit_src / "weights/rigify.npz"):
        col = np.zeros(n_v); col[idx] = w; v_bone[name] = col

    total = np.zeros(n_v)
    acc = np.zeros((n_v, 45, 3))
    for name, vs, ve, vbones, ms, me_, mgroups in segments():
        vo, vr, vl = frame(v_joint[vs], v_joint[ve])
        mo, mr, ml = frame(m_joint[ms], m_joint[me_])
        ws = sum((v_bone[b] for b in vbones if b in v_bone), np.zeros(n_v))
        wm = sum((m_w[:, m_group[g]] for g in mgroups if g in m_group), np.zeros(n_m))
        part = np.nonzero(wm > 0.15)[0]
        if len(part) < 4:
            print("  segment without MHR vertices:", name); continue
        turn = vr @ mr.T  # MHR bone frame -> Vitruvian bone frame
        sel = np.nonzero(ws > 0.02)[0]
        local = (positions[sel] - vo) @ vr
        local[:, 0] *= ml / vl
        q = mo + local @ mr.T
        near, dist = knn(m_basis[part], q, 4)
        w = 1 / np.maximum(dist, 1e-4)
        w /= w.sum(1, keepdims=True)
        d = np.einsum("qk,qkcx->qcx", w, m_delta[part][near])
        acc[sel] += ws[sel, None, None] * (d @ turn.T)
        total[sel] += ws[sel]
        print(f"  {name}: {len(sel)} Vitruvian vertices on {len(part)} MHR vertices")
    missing = total == 0
    covered = ~missing
    acc[covered] /= total[covered][:, None, None]
    # Vertices no part claims take their nearest claimed neighbour's.
    if missing.any():
        ci, mi_ = np.nonzero(covered)[0], np.nonzero(missing)[0]
        near, _ = knn(positions[ci], positions[mi_], 1)
        acc[mi_] = acc[ci[near[:, 0]]]
        print("  vertices from a neighbour:", len(mi_))
    # Where two parts meet (thigh and pelvis at the crotch, the eyelids
    # against the eye) the parts' deltas disagree: a few rounds of Laplacian
    # smoothing of the delta field over the mesh close the seams; the eyes,
    # set rigid below, are not smoothed.
    rigid = np.isin(vert_material, ["Iris", "Pupil", "Sclera_Cornea"])
    a, b = edges[:, 0], edges[:, 1]
    degree = np.bincount(np.concatenate([a, b]), minlength=n_v).astype(np.float64)
    flat = acc.reshape(n_v, -1)
    for _ in range(12):
        nsum = np.zeros_like(flat)
        np.add.at(nsum, a, flat[b])
        np.add.at(nsum, b, flat[a])
        avg = nsum / np.maximum(degree, 1)[:, None]
        flat = np.where(rigid[:, None], flat, 0.5 * flat + 0.5 * avg)
    acc = flat.reshape(n_v, 45, 3)
    # Each eye moves as a whole, so no eye is squashed.
    eye = np.isin(vert_material, ["Iris", "Pupil", "Sclera_Cornea"])
    for side in (positions[:, 0] > 0, positions[:, 0] <= 0):
        s = eye & side
        if s.any():
            acc[s] = acc[s].mean(0)
    # The mouth's inside (teeth, gums, tongue) follows the lips and face
    # around it: moved as one block it pushed the gums out through the upper
    # lip when a head component reshaped the mouth.
    inside = np.nonzero(vert_material == "Mouth")[0]
    skin = np.nonzero(vert_material == "Skin")[0]
    near, _ = knn(positions[skin], positions[inside], 8)
    acc[inside] = acc[skin][near].mean(1)
    # Then smoothed over the mouth's own pieces only, so an arch of teeth
    # moves nearly whole instead of stretching.
    is_in = np.zeros(n_v, bool); is_in[inside] = True
    inner = is_in[a] & is_in[b]
    ia, ib = a[inner], b[inner]
    deg = np.bincount(np.concatenate([ia, ib]), minlength=n_v).astype(np.float64)
    flat = acc.reshape(n_v, -1)
    for _ in range(40):
        nsum = np.zeros_like(flat)
        np.add.at(nsum, ia, flat[ib])
        np.add.at(nsum, ib, flat[ia])
        upd = deg > 0
        flat[upd] = 0.5 * flat[upd] + 0.5 * nsum[upd] / deg[upd, None]
    acc = flat.reshape(n_v, 45, 3)
    morphs = []
    for i in range(45):
        group = "Body" if i < 20 else "Head" if i < 40 else "Hands"
        morphs.append((f"MHR_{group}_{i:02d}", group, -3, 3, np.arange(n_v, dtype=np.uint32), acc[:, i]))
    for o in [arm, mobj]:
        bpy.data.objects.remove(o)
    return morphs


def load_morph(f: Path):
    z = np.load(f)
    if isinstance(z, np.ndarray):
        d = z.astype(np.float64)
        return np.arange(len(d), dtype=np.uint32), d
    return z["idx"].astype(np.uint32), z["delta"].astype(np.float64)


def mhr(src: Path, out: Path, _tex: int, _mhr=None, _keep=False):
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
    {"vitruvian": vitruvian, "mhr": mhr}[a.base](a.src.resolve(), out.resolve(), a.tex, a.mhr.resolve() if a.mhr else None, a.keep_textures)


main()
