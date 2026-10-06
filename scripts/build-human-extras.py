"""Everything the person creator puts on a body, for the Vitruvian base.

Usage (Blender 5.x, no window; light: no textures are read):
  blender -b --factory-startup -t 2 --python scripts/build-human-extras.py -- --src <CharMorph-Vitruvian checkout>

Writes `public/models/humans/vitruvian/extras.json` + `extras.bin`:
  masks      per mesh vertex, uint8: scalp (the `hair` vertex group, where
             hair grows), lips (`ColLipMask`, for lipstick), beard
             (`BeardShadowMask`, for stubble)
  regions    per mesh vertex: body region (head, neck, chest, abdomen,
             pelvis, upper arm, forearm, hand, thigh, shin, foot, toes; from
             the rig's deform weights) and how far along its limb (0..255),
             plus the joints' rest heights: what clothes are cut by
  lashes     the eyelid rims (ordered vertex runs, upper and lower, each eye):
             where eyelashes grow
  hair       the CharMorph grooms (guide strands, body space) and their child
             settings (count, radius, clump, roughness) from hair.blend; the
             eyebrow grooms likewise
  garments   the modelled Shirt and Pants: mesh, UVs, and each vertex bound
             to the nearest body vertices (inverse-square weights), so it
             moves by their weighted displacement as the body is morphed -
             CharMorph's own fitting (lib/fit_calc.py, FitBinding)
"""

import argparse
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils.kdtree import KDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))


def to_three(v):
    v = np.asarray(v, dtype=np.float64)
    return np.stack([v[..., 0], v[..., 2], -v[..., 1]], axis=-1)


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


def npz_groups(f):
    z = np.load(f)
    names = [x.decode() for x in bytes(z["names"]).split(b"\0")]
    i = 0
    for name, c in zip(names, z["cnt"]):
        c = int(c)
        yield name, z["idx"][i:i + c].astype(np.int64), z["weights"][i:i + c].astype(np.float64)
        i += c


REGIONS = ["head", "neck", "chest", "abdomen", "pelvis", "upperarm", "forearm", "hand", "thigh", "shin", "foot", "toes"]


def region_of(bone):
    b = bone.replace("DEF-", "")
    if b.startswith("spine.006"): return "head"
    if b.startswith(("spine.004", "spine.005")): return "neck"
    if b.startswith(("spine.002", "spine.003", "breast", "chest", "shoulder")): return "chest"
    if b.startswith(("spine.001", "abdomen")): return "abdomen"
    if b.startswith(("spine", "pelvis")): return "pelvis"
    if b.startswith("upper_arm"): return "upperarm"
    if b.startswith("forearm"): return "forearm"
    if b.startswith(("hand", "palm", "f_", "thumb")): return "hand"
    if b.startswith("thigh"): return "thigh"
    if b.startswith(("shin", "knee")): return "shin"
    if b.startswith("foot"): return "foot"
    if b.startswith(("toe", "big_toe")): return "toes"
    return None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True, type=Path)
    p.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "public/models/humans/vitruvian")
    a = p.parse_args(sys.argv[sys.argv.index("--") + 1:])
    src = a.src.resolve()
    out = a.out.resolve()
    meta = json.loads((out / "base.json").read_text())

    bpy.ops.wm.open_mainfile(filepath=str(src / "char.blend"))
    obj = bpy.data.objects["cm_vitruvian"]
    me = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    n = len(me.vertices)
    positions = to_three(np.load(src / "morphs/L1/Default.npy"))
    pack = Pack()
    info = {"format": "roadcraft-humans-extras/1"}

    # ---- masks
    scalp = np.zeros(n, np.float32)
    gi = obj.vertex_groups["hair"].index
    for v in me.vertices:
        for g in v.groups:
            if g.group == gi:
                scalp[v.index] = g.weight
    lips = np.zeros(n, np.float32)
    lv = np.zeros(len(me.loops), np.int64); me.loops.foreach_get("vertex_index", lv)
    col = np.zeros(len(me.loops) * 4, np.float32); me.attributes["ColLipMask"].data.foreach_get("color", col)
    np.maximum.at(lips, lv, col.reshape(-1, 4)[:, 0])
    beard = np.zeros(n * 4, np.float32); me.attributes["BeardShadowMask"].data.foreach_get("color", beard)
    beard = beard.reshape(-1, 4)[:, 0]
    for name, arr in (("scalpMask", scalp), ("lipMask", lips), ("beardMask", beard)):
        pack.add(name, (np.clip(arr, 0, 1) * 255).round().astype(np.uint8))
        print(f"  {name}: {(arr > 0.5).sum()} vertices")

    # ---- body regions, from the rig's deform weights, and joints
    best = np.zeros(n); region = np.full(n, 255, np.uint8)
    for name, idx, w in npz_groups(src / "weights/rigify.npz"):
        r = region_of(name)
        if r is None:
            continue
        better = w > best[idx]
        best[idx[better]] = w[better]
        region[idx[better]] = REGIONS.index(r)
    joints = {}
    for name, idx, w in npz_groups(src / "joints/rigify.npz"):
        joints[name[len("joint_"):]] = (positions[idx] * w[:, None]).sum(0) / w.sum()
    along = np.zeros(n, np.float32)
    limbs = {"upperarm": ("upper_arm.{s}_head", "upper_arm.{s}_tail"), "forearm": ("upper_arm.{s}_tail", "forearm.{s}_tail"),
             "thigh": ("thigh.{s}_head", "thigh.{s}_tail"), "shin": ("thigh.{s}_tail", "shin.{s}_tail"),
             "foot": ("shin.{s}_tail", "foot.{s}_tail")}
    for r, (ja, jb) in limbs.items():
        for s, sign in (("L", 1), ("R", -1)):
            sel = (region == REGIONS.index(r)) & (np.sign(positions[:, 0]) == sign)
            A, B = joints[ja.format(s=s)], joints[jb.format(s=s)]
            d = B - A
            along[sel] = ((positions[sel] - A) @ d) / (d @ d)
    pack.add("region", region)
    pack.add("along", (np.clip(along, 0, 1) * 255).round().astype(np.uint8))
    land = {k: float(joints[j][1]) for k, j in {
        "hip": "thigh.L_head", "knee": "thigh.L_tail", "ankle": "shin.L_tail", "waist": "spine.001_tail",
        "chest": "spine.002_tail", "neckBase": "spine.004_head", "shoulder": "upper_arm.L_head", "crotch": "spine_head"}.items()}
    info["regions"] = {"names": REGIONS, "landmarks": land}

    # ---- eyelid rims: the tear line runs along both lid margins of each eye
    ls = np.zeros(len(me.polygons), np.int64); me.polygons.foreach_get("loop_start", ls)
    lt = np.zeros(len(me.polygons), np.int64); me.polygons.foreach_get("loop_total", lt)
    mi = np.zeros(len(me.polygons), np.int64); me.polygons.foreach_get("material_index", mi)
    IRIS, SKIN, TEARLINE = 0, 4, 7
    iris = np.unique(np.concatenate([lv[ls[f]:ls[f] + lt[f]] for f in range(len(ls)) if mi[f] == IRIS]))
    tear = np.unique(np.concatenate([lv[ls[f]:ls[f] + lt[f]] for f in range(len(ls)) if mi[f] == TEARLINE]))
    print("  beard mask max", float(beard.max()), "scalp > 0:", int((scalp > 0).sum()), "tear line vertices", len(tear))
    lashes = {}
    for side, sign in (("L", 1), ("R", -1)):
        centre = positions[iris[np.sign(positions[iris, 0]) == sign]].mean(0)
        # The tear line's front edge: of its vertices, the half nearest the
        # camera side is the lid margin where lashes root.
        verts = tear[np.sign(positions[tear, 0]) == sign]
        front = positions[verts, 2] >= np.median(positions[verts, 2])
        verts = verts[front].astype(np.int64)
        rel = positions[verts] - centre
        upper = verts[rel[:, 1] > 0.0005]
        lower = verts[rel[:, 1] < -0.0005]
        lashes[side] = {"upper": upper[np.argsort(positions[upper, 0] * sign)].tolist(),
                        "lower": lower[np.argsort(positions[lower, 0] * sign)].tolist()}
        print(f"  lashes {side}: upper {len(upper)}, lower {len(lower)}")
    info["lashes"] = lashes

    # ---- grooms
    def groom(f):
        z = np.load(f)
        return z["cnt"].astype(np.uint16), to_three(z["data"]).astype(np.float32)
    children = {"SlickedBack": (50, 0.005, 0.19, 0.05), "Back1": (100, 0.006, 0.25, 0.05), "Bob": (100, 0.01, 0.0, 0.05),
                "Combover_zoro_d": (10, 0.005, 0.81, 0.05), "Eve": (25, 0.005, 0.4, 0.0), "SceneHair_1_O4saken": (10, 0.01, 1.0, 0.05)}
    hair = []
    for style, (count, radius, clump, rough) in children.items():
        cnt, pts = groom(src / "hairstyles" / f"{style}.npz")
        pack.add(f"hair.{style}.cnt", cnt); pack.add(f"hair.{style}.pts", pts.reshape(-1), 3)
        hair.append({"id": style, "children": count, "radius": radius, "clump": clump, "roughness": rough, "guides": int(len(cnt))})
        print(f"  groom {style}: {len(cnt)} guides, {len(pts)} points")
    brows = []
    for f in sorted((src / "hairstyles").glob("mind_eyebrows_*.npz")):
        cnt, pts = groom(f)
        pack.add(f"brow.{f.stem}.cnt", cnt); pack.add(f"brow.{f.stem}.pts", pts.reshape(-1), 3)
        brows.append({"id": f.stem, "strands": int(len(cnt))})
    info["hair"] = hair
    info["brows"] = brows

    # ---- modelled garments, bound to the body skin
    skin_verts = np.unique(np.concatenate([lv[ls[f]:ls[f] + lt[f]] for f in range(len(ls)) if mi[f] in (SKIN, 5)]))
    tree = KDTree(len(skin_verts))
    for j, v in enumerate(skin_verts):
        tree.insert(positions[v], j)
    tree.balance()
    garments = []
    for name in ("Shirt", "Pants"):
        with bpy.data.libraries.load(str(src / "assets" / f"{name}.blend")) as (data_from, data_to):
            data_to.objects = [name]
        g = data_to.objects[0]
        gm = g.data
        gw = np.array(g.matrix_world)
        co = np.zeros(len(gm.vertices) * 3); gm.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3) @ gw[:3, :3].T + gw[:3, 3]
        gpos = to_three(co)
        gls = np.zeros(len(gm.polygons), np.int64); gm.polygons.foreach_get("loop_start", gls)
        glt = np.zeros(len(gm.polygons), np.int64); gm.polygons.foreach_get("loop_total", glt)
        glv = np.zeros(len(gm.loops), np.int64); gm.loops.foreach_get("vertex_index", glv)
        uvname = gm.uv_layers[0].name
        guv = np.zeros(len(gm.loops) * 2, np.float32); gm.attributes[uvname].data.foreach_get("vector", guv)
        guv = guv.reshape(-1, 2)
        # Render vertices split where UVs are cut (as the body's).
        keys = np.stack([glv, np.round(guv[:, 0] * 1e5).astype(np.int64), np.round(guv[:, 1] * 1e5).astype(np.int64)], 1)
        _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
        inverse = inverse.reshape(-1)
        tris = []
        for f in range(len(gls)):
            loops = list(range(gls[f], gls[f] + glt[f]))
            for i in range(1, len(loops) - 1):
                tris.append((loops[0], loops[i], loops[i + 1]))
        index = inverse[np.array(tris)].astype(np.uint32).reshape(-1)
        K = 6
        bind_idx = np.zeros((len(gpos), K), np.uint32)
        bind_w = np.zeros((len(gpos), K), np.float32)
        for i, pnt in enumerate(gpos):
            near = tree.find_n(pnt, K)
            w = np.array([1.0 / (d * d + 1e-8) for _, _, d in near])
            bind_idx[i] = [skin_verts[j] for _, j, _ in near]
            bind_w[i] = w / w.sum()
        pre = f"garment.{name}."
        pack.add(pre + "positions", gpos.astype(np.float32).reshape(-1), 3)
        pack.add(pre + "renderSource", glv[first].astype(np.uint32))
        pack.add(pre + "renderUv", guv[first].reshape(-1), 2)
        pack.add(pre + "index", index)
        pack.add(pre + "bindIndex", bind_idx.reshape(-1), K)
        pack.add(pre + "bindWeight", bind_w.reshape(-1), K)
        garments.append({"id": name, "vertices": int(len(gpos)), "bindK": K})
        print(f"  garment {name}: {len(gpos)} vertices, {len(index) // 3} triangles")
    info["garments"] = garments
    info["sections"] = pack.sections
    (out / "extras.bin").write_bytes(b"".join(pack.chunks))
    (out / "extras.json").write_text(json.dumps(info, indent=1))
    print(f"wrote {out / 'extras.bin'} ({pack.offset / 1e6:.1f} MB)")
    assert meta["vertexCount"] == n


main()
