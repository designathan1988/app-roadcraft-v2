"""
Registers the MakeHuman base mesh (hm08) on the Vitruvian, so the MakeHuman
clothes, hair and other proxies (`public/models/people/proxies`, each pinned
to hm08 vertices by its .mhclo binding) can be worn by the human generator's
people.

Method: nonrigid ICP (Amberg, Romdhani and Vetter, "Optimal Step Nonrigid ICP
Algorithms for Surface Registration", CVPR 2007): the template (hm08) is
deformed towards the target (the Vitruvian's skin) in steps of decreasing
stiffness; at each step every template vertex takes its closest target point,
correspondences whose normals disagree are dropped, and the displacement
field is kept smooth. Here the stiffness is Laplacian smoothing of the
displacements (fewer passes as the steps go on), and two things keep the
correspondences honest on a body: a vertex only looks for its target on the
same body part (by bone: an arm never snaps to the torso), and the start is
each body part of hm08 aligned on the Vitruvian's (centroid, axis, size) -
the landmarks of the method.

hm08's helper shells (tights, skirt, hair), which garments pin to, follow the
displacement of the body round them.

Output, `public/models/humans/vitruvian/makehuman.{json,bin}`: per hm08
vertex its position on the Vitruvian at rest (metres) and the four Vitruvian
vertices it follows (indices, weights), so for any generated body
hm08 = rest + sum w * (shape - vitruvianRest), and `fitProxy` does the rest.

Run with Blender's Python (numpy), two threads, below normal priority:
  OMP_NUM_THREADS=2 "<blender>/5.2/python/bin/python.exe" scripts/register-makehuman.py
"""
import json
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MH = ROOT / 'public/models/people'
VIT = ROOT / 'public/models/humans/vitruvian'

REGION = {'head': 0, 'neck': 1, 'chest': 2, 'abdomen': 3, 'pelvis': 4, 'upperarm': 5, 'forearm': 6, 'hand': 7, 'thigh': 8, 'shin': 9, 'foot': 10, 'toes': 11}
LIMBS = {5, 6, 7, 8, 9, 10, 11}


def bone_region(name):
    if name in ('Root', 'pelvis'):
        return REGION['pelvis']
    if name == 'spine_01':
        return REGION['abdomen']
    if name in ('spine_02', 'spine_03') or name.startswith('clavicle'):
        return REGION['chest']
    if name == 'neck_01':
        return REGION['neck']
    if name == 'head':
        return REGION['head']
    if name.startswith('upperarm'):
        return REGION['upperarm']
    if name.startswith('lowerarm'):
        return REGION['forearm']
    if name.startswith(('hand', 'thumb', 'index', 'middle', 'ring', 'pinky')):
        return REGION['hand']
    if name.startswith('thigh'):
        return REGION['thigh']
    if name.startswith('calf'):
        return REGION['shin']
    if name.startswith('foot'):
        return REGION['foot']
    if name.startswith('ball'):
        return REGION['toes']
    raise ValueError(name)


def section(meta, data, name):
    s = next(x for x in meta['sections'] if x['name'] == name)
    dtype = {'float32': np.float32, 'uint32': np.uint32, 'uint16': np.uint16, 'uint8': np.uint8, 'int16': np.int16}[s['type']]
    return np.frombuffer(data, dtype=dtype, count=s['count'] * s['itemSize'], offset=s['byteOffset']).reshape(s['count'], s['itemSize']) if s['itemSize'] > 1 else np.frombuffer(data, dtype=dtype, count=s['count'], offset=s['byteOffset'])


def vertex_normals(pos, tris):
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    n = np.zeros_like(pos)
    for k in range(3):
        np.add.at(n, tris[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def edges_of(tris, count):
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    deg = np.bincount(e.ravel(), minlength=count).astype(np.float64)
    return e, deg


def smooth(field, edges, deg, passes, mask=None):
    """Laplacian smoothing of a per-vertex field over the mesh's edges (vertices with no edges keep their value)."""
    f = field.copy()
    for _ in range(passes):
        acc = np.zeros_like(f)
        np.add.at(acc, edges[:, 0], f[edges[:, 1]])
        np.add.at(acc, edges[:, 1], f[edges[:, 0]])
        has = deg > 0
        avg = f.copy()
        avg[has] = acc[has] / deg[has, None]
        new = 0.5 * f + 0.5 * avg
        if mask is not None:
            new[~mask] = f[~mask]
        f = new
    return f


def nearest(points, queries, chunk=400):
    """Index of and squared distance to the nearest of `points` for each query (brute force in chunks)."""
    pp = (points ** 2).sum(1)
    idx = np.empty(len(queries), np.int64)
    dist = np.empty(len(queries))
    for s in range(0, len(queries), chunk):
        q = queries[s:s + chunk]
        d = (q ** 2).sum(1)[:, None] + pp[None, :] - 2 * q @ points.T
        i = d.argmin(1)
        idx[s:s + chunk] = i
        dist[s:s + chunk] = d[np.arange(len(q)), i]
    return idx, np.maximum(dist, 0)


def knn(points, queries, k, chunk=400):
    pp = (points ** 2).sum(1)
    idx = np.empty((len(queries), k), np.int64)
    dist = np.empty((len(queries), k))
    for s in range(0, len(queries), chunk):
        q = queries[s:s + chunk]
        d = (q ** 2).sum(1)[:, None] + pp[None, :] - 2 * q @ points.T
        i = np.argpartition(d, k, axis=1)[:, :k]
        dd = np.take_along_axis(d, i, 1)
        o = np.argsort(dd, 1)
        idx[s:s + chunk] = np.take_along_axis(i, o, 1)
        dist[s:s + chunk] = np.maximum(np.take_along_axis(dd, o, 1), 0)
    return idx, dist


def main():
    # --- hm08 -----------------------------------------------------------
    mh_meta = json.loads((MH / 'base.json').read_text())
    mh_data = (MH / 'base.bin').read_bytes()
    P = section(mh_meta, mh_data, 'positions').astype(np.float64) * 0.1  # decimetres -> metres
    quads = section(mh_meta, mh_data, 'faceVerts').astype(np.int64)
    fgroup = section(mh_meta, mh_data, 'faceGroup')
    body_gid = mh_meta['faceGroups'].index('body')
    body_faces = quads[fgroup == body_gid]
    tris_all = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    tris_all = tris_all[(tris_all[:, 0] != tris_all[:, 1]) & (tris_all[:, 1] != tris_all[:, 2]) & (tris_all[:, 0] != tris_all[:, 2])]
    body_tris = np.concatenate([body_faces[:, [0, 1, 2]], body_faces[:, [0, 2, 3]]])
    body_tris = body_tris[(body_tris[:, 0] != body_tris[:, 1]) & (body_tris[:, 1] != body_tris[:, 2]) & (body_tris[:, 0] != body_tris[:, 2])]
    n_mh = len(P)
    is_body = np.zeros(n_mh, bool)
    is_body[body_tris.ravel()] = True

    skel = json.loads((MH / 'skeleton-game-engine.json').read_text())
    wbin = (MH / 'weights-game-engine.bin').read_bytes()
    lay = skel['weights']['layout']
    joints = np.frombuffer(wbin, np.uint8, count=n_mh * 4, offset=lay['joints']['byteOffset']).reshape(n_mh, 4)
    weights = np.frombuffer(wbin, np.uint16, count=n_mh * 4, offset=lay['weights']['byteOffset']).reshape(n_mh, 4)
    names = [b['name'] for b in skel['bones']]
    bone_reg = np.array([bone_region(n) for n in names])
    # Region per vertex: the body part with the most weight.
    mh_region = np.full(n_mh, 255, np.int64)
    score = np.zeros((n_mh, 12))
    for k in range(4):
        np.add.at(score, (np.arange(n_mh), bone_reg[joints[:, k]]), weights[:, k].astype(np.float64))
    weighted = score.sum(1) > 0
    mh_region[weighted] = score[weighted].argmax(1)

    # --- Vitruvian ---------------------------------------------------------
    v_meta = json.loads((VIT / 'base.json').read_text())
    v_data = (VIT / 'base.bin').read_bytes()
    V = section(v_meta, v_data, 'positions').astype(np.float64)
    rsrc = section(v_meta, v_data, 'renderSource').astype(np.int64)
    vindex = section(v_meta, v_data, 'index').astype(np.int64)
    skin = []
    for g in v_meta['groups']:
        if g['material'] in ('Skin', 'Covered'):
            skin.append(rsrc[vindex[g['start']:g['start'] + g['count']]])
    v_tris = np.concatenate(skin).reshape(-1, 3)
    n_v = len(V)
    v_skin = np.zeros(n_v, bool)
    v_skin[v_tris.ravel()] = True
    e_meta = json.loads((VIT / 'extras.json').read_text())
    e_data = (VIT / 'extras.bin').read_bytes()
    v_region = section(e_meta, e_data, 'region').astype(np.int64)
    VN = vertex_normals(V, v_tris)

    side = lambda pts: np.where(pts[:, 0] >= 0, 1, -1)
    mh_side, v_side = side(P), side(V)

    # --- start: each body part of hm08 aligned on the Vitruvian's ----------
    X = P.copy()
    for r in range(12):
        for s in ((1, -1) if r in LIMBS else (0,)):
            m = is_body & (mh_region == r) & ((mh_side == s) if s else True)
            t = v_skin & (v_region == r) & ((v_side == s) if s else True)
            if m.sum() < 10 or t.sum() < 10:
                continue
            A, B = P[m], V[t]
            ca, cb = A.mean(0), B.mean(0)
            if r in LIMBS:
                # Major axis of each part; rotate hm08's onto the Vitruvian's, scale along and across it.
                ua = np.linalg.svd(A - ca, full_matrices=False)[2][0]
                ub = np.linalg.svd(B - cb, full_matrices=False)[2][0]
                if ua @ ub < 0:
                    ua = -ua
                la, lb = (A - ca) @ ua, (B - cb) @ ub
                along = (lb.max() - lb.min()) / max(1e-6, la.max() - la.min())
                ra = np.linalg.norm((A - ca) - np.outer(la, ua), axis=1).mean()
                rb = np.linalg.norm((B - cb) - np.outer(lb, ub), axis=1).mean()
                across = rb / max(1e-6, ra)
                # Rotation taking ua to ub (Rodrigues).
                v = np.cross(ua, ub)
                c = ua @ ub
                K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
                R = np.eye(3) + K + K @ K / (1 + c)
                mm = np.where(((mh_region == r) & ((mh_side == s))))[0]
                q = P[mm] - ca
                l = q @ ua
                q = np.outer(l * along, ua) + (q - np.outer(l, ua)) * across
                X[mm] = cb + q @ R.T
            else:
                # Upright parts: per world axis, by spread.
                k = (B.std(0) / np.maximum(A.std(0), 1e-6))
                mm = np.where(((mh_region == r) & ((mh_side == s) if s else True)))[0]
                X[mm] = cb + (P[mm] - ca) * k
    D = X - P
    # Unweighted vertices (helpers, joint cubes) start with the displacement of the body near them.
    body_idx = np.where(is_body & (mh_region != 255))[0]
    rest_idx = np.where(~(is_body & (mh_region != 255)))[0]
    nb, nd = knn(P[body_idx], P[rest_idx], 4)
    w = 1 / (np.sqrt(nd) + 1e-4)
    w /= w.sum(1, keepdims=True)
    D[rest_idx] = (D[body_idx][nb] * w[:, :, None]).sum(1)

    edges, deg = edges_of(tris_all, n_mh)
    # Seams between parts: smooth the start.
    D = smooth(D, edges, deg, 40)

    # --- nonrigid ICP, stiffness decreasing ---------------------------------
    groups = {}
    for r in range(12):
        for s in ((1, -1) if r in LIMBS else (0,)):
            t = np.where(v_skin & (v_region == r) & ((v_side == s) if s else True))[0]
            m = np.where(is_body & (mh_region == r) & ((mh_side == s) if s else True))[0]
            if len(t) and len(m):
                groups[(r, s)] = (m, t)
    for stiffness, steps in ((60, 3), (30, 3), (15, 3), (8, 3), (4, 3), (2, 3), (1, 4)):
        for _ in range(steps):
            X = P + D
            N = vertex_normals(X, body_tris)
            R = np.zeros_like(D)
            ok = np.zeros(n_mh, bool)
            for (m, t) in groups.values():
                i, d2 = nearest(V[t], X[m])
                j = t[i]
                # Point to plane: the target is the Vitruvian's tangent plane at the nearest vertex.
                off = ((X[m] - V[j]) * VN[j]).sum(1)
                target = X[m] - VN[j] * off[:, None]
                agree = (N[m] * VN[j]).sum(1) > 0.5
                near = d2 < 0.05 ** 2
                good = agree & near
                R[m[good]] = target[good] - X[m[good]]
                ok[m[good]] = True
            # The residual spread to vertices without a correspondence, then the step taken and kept smooth.
            step = smooth(R, edges, deg, stiffness)
            weight = smooth(ok[:, None].astype(np.float64), edges, deg, stiffness)
            step = step / np.maximum(weight, 0.05)
            D = D + 0.8 * step
            D = smooth(D, edges, deg, max(1, stiffness // 4))
        X = P + D
        res = []
        for (m, t) in groups.values():
            _, d2 = nearest(V[t], X[m])
            res.append(np.sqrt(d2))
        res = np.concatenate(res)
        print(f'stiffness {stiffness:3d}: mean {res.mean() * 1000:.2f} mm, 95% {np.percentile(res, 95) * 1000:.2f} mm, max {res.max() * 1000:.1f} mm', flush=True)

    # The helper shells garments pin to (tights: a skin-tight copy of the
    # body; skirt: on the body at the hips, stretched between the legs; hair)
    # are carried as MakeHuman carries a garment: each vertex is a point on
    # its nearest body triangle plus an offset along that triangle's normal,
    # rebuilt on the registered body.
    Xb = P + D
    tri = body_tris
    cent = P[tri].mean(1)
    cand, _ = knn(cent, P[rest_idx], 24)
    Q = P[rest_idx]
    best = np.full(len(rest_idx), -1)
    bd = np.full(len(rest_idx), np.inf)
    bu = np.zeros(len(rest_idx)); bv = np.zeros(len(rest_idx)); boff = np.zeros(len(rest_idx))
    for c in range(cand.shape[1]):
        t = tri[cand[:, c]]
        A, B, Cc = P[t[:, 0]], P[t[:, 1]], P[t[:, 2]]
        e1, e2 = B - A, Cc - A
        n = np.cross(e1, e2)
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        off = ((Q - A) * n).sum(1)
        q = Q - n * off[:, None] - A
        d11, d12, d22 = (e1 * e1).sum(1), (e1 * e2).sum(1), (e2 * e2).sum(1)
        q1, q2 = (q * e1).sum(1), (q * e2).sum(1)
        den = np.maximum(d11 * d22 - d12 * d12, 1e-18)
        u = (d22 * q1 - d12 * q2) / den
        v = (d11 * q2 - d12 * q1) / den
        # Clamp into the triangle; the distance then counts the in-plane overshoot.
        u2, v2 = np.clip(u, 0, 1), np.clip(v, 0, 1)
        over = u2 + v2 > 1
        s_ = np.where(over, u2 + v2, 1)
        u2, v2 = u2 / s_, v2 / s_
        foot = A + e1 * u2[:, None] + e2 * v2[:, None]
        dist = np.linalg.norm(Q - foot, axis=1)
        better = dist < bd
        best[better] = cand[better, c]; bd[better] = dist[better]
        bu[better] = u2[better]; bv[better] = v2[better]; boff[better] = off[better]
    t = tri[best]
    A, B, Cc = Xb[t[:, 0]], Xb[t[:, 1]], Xb[t[:, 2]]
    n = np.cross(B - A, Cc - A)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    D[rest_idx] = A + (B - A) * bu[:, None] + (Cc - A) * bv[:, None] + n * boff[:, None] - P[rest_idx]
    print(f'helpers: {len(rest_idx)} vertices on body triangles, offset median {np.median(np.abs(boff)) * 1000:.1f} mm', flush=True)
    X = P + D
    names = {v: k for k, v in REGION.items()}
    for (r, s), (m, t) in groups.items():
        i, _ = nearest(V[t], X[m])
        j = t[i]
        plane = np.abs(((X[m] - V[j]) * VN[j]).sum(1))
        print(f'  {names[r]:9s} {s:+d}: point-to-plane mean {plane.mean() * 1000:5.2f} mm, 95% {np.percentile(plane, 95) * 1000:5.2f} mm, max {plane.max() * 1000:5.1f} mm', flush=True)
    # Each hm08 vertex follows its four nearest Vitruvian skin vertices.
    skin_idx = np.where(v_skin)[0]
    bi, bd = knn(V[skin_idx], X, 4)
    bw = 1 / (np.sqrt(bd) + 1e-4)
    bw /= bw.sum(1, keepdims=True)
    bind = skin_idx[bi].astype(np.uint32)

    pos = X.astype(np.float32).tobytes()
    idx = bind.tobytes()
    wts = bw.astype(np.float32).tobytes()
    meta = {
        'format': 'roadcraft-makehuman-on-vitruvian/1',
        'units': 'metres, the Vitruvian rest frame (+Y up, faces +Z)',
        'method': 'nonrigid ICP (Amberg et al. 2007), per body part, Laplacian stiffness',
        'vertexCount': n_mh,
        'k': 4,
        'sections': [
            {'name': 'positions', 'type': 'float32', 'itemSize': 3, 'count': n_mh, 'byteOffset': 0},
            {'name': 'bindIndex', 'type': 'uint32', 'itemSize': 4, 'count': n_mh, 'byteOffset': len(pos)},
            {'name': 'bindWeight', 'type': 'float32', 'itemSize': 4, 'count': n_mh, 'byteOffset': len(pos) + len(idx)},
        ],
    }
    (VIT / 'makehuman.bin').write_bytes(pos + idx + wts)
    (VIT / 'makehuman.json').write_text(json.dumps(meta, indent=1))
    print('written', VIT / 'makehuman.bin', len(pos + idx + wts), 'bytes')


if __name__ == '__main__':
    main()
