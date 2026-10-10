/** Independent studio formats. No imports from, or writes to, the game. */
export type Kind = 'signal' | 'traffic' | 'transit' | 'material' | 'animation' | 'sound';
export type Side = 'N' | 'E' | 'S' | 'W';
export type Point = { x: number; y: number };
export type Node = Point & { id: string; name: string };
export type Edge = { id: string; from: string; to: string; speed: number; both: boolean };
export type Network = { nodes: Node[]; edges: Edge[] };
type Base = { format: 'roadcraft-studio/1'; kind: Kind; name: string };
export type Phase = { id: string; name: string; green: number; amber: number; clearance: number; movements: string[]; crossings: Side[] };
export type SignalProject = Base & { kind: 'signal'; lanes: number; width: number; radius: number; phases: Phase[]; assignments: { movement: string; lane: number; exit: number }[] };
export type Flow = { id: string; name: string; from: string; to: string; rate: number };
export type TrafficProject = Base & { kind: 'traffic'; network: Network; flows: Flow[]; seed: number; speed: number; buses: number; trucks: number; peakStart: number; peakEnd: number; multiplier: number; start: number; duration: number };
export type Line = { id: string; name: string; color: string; stops: string[]; headway: number; speed: number; dwell: number; start: number; end: number; capacity: number; returnTrip: boolean };
export type TransitProject = Base & { kind: 'transit'; network: Network; lines: Line[] };
export type MaterialProject = Base & { kind: 'material'; color: string; roughness: number; metalness: number; scale: number; wear: number; pattern: 'asphalt' | 'concrete' | 'brick' | 'fabric' | 'plain'; shape: 'sphere' | 'cube' | 'plane'; texture: string | null };
export const joints = ['leftArm', 'rightArm', 'leftElbow', 'rightElbow', 'leftLeg', 'rightLeg', 'leftKnee', 'rightKnee', 'head', 'torso', 'height'] as const;
export type Joint = typeof joints[number];
export type Pose = Record<Joint, number>;
export type Keyframe = { time: number; pose: Pose };
export type AnimationProject = Base & { kind: 'animation'; duration: number; loop: boolean; grounded: boolean; keys: Keyframe[] };
export type Source = Point & { id: string; name: string; type: 'motor' | 'wind' | 'steps' | 'tone' | 'file'; frequency: number; volume: number; radius: number; reference: number; loop: boolean; audio: string | null };
export type SoundProject = Base & { kind: 'sound'; listener: Point; sources: Source[]; duration: number; master: number };
export type Project = SignalProject | TrafficProject | TransitProject | MaterialProject | AnimationProject | SoundProject;
export const sides: Side[] = ['N', 'E', 'S', 'W'];
export const sideNames: Record<Side, string> = { N: 'Norte', E: 'Leste', S: 'Sul', W: 'Oeste' };
export const movements = sides.flatMap(from => sides.filter(to => to !== from).map(to => `${from}-${to}`));
export const neutralPose = (): Pose => ({ leftArm: 0, rightArm: 0, leftElbow: 0, rightElbow: 0, leftLeg: 0, rightLeg: 0, leftKnee: 0, rightKnee: 0, head: 0, torso: 0, height: 0 });

export function defaultNetwork(): Network {
  const nodes: Node[] = [
    { id: 'a', name: 'Estação', x: -60, y: -40 }, { id: 'b', name: 'Centro', x: 0, y: -40 },
    { id: 'c', name: 'Parque', x: 60, y: -40 }, { id: 'd', name: 'Bairro', x: 60, y: 40 },
    { id: 'e', name: 'Escola', x: 0, y: 40 }, { id: 'f', name: 'Terminal', x: -60, y: 40 },
  ];
  return { nodes, edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'a'], ['b', 'e']].map(([from, to], i) => ({ id: `r${i}`, from: from!, to: to!, speed: 40, both: true })) };
}
export function createProject(kind: Kind): Project {
  const base: Base = { format: 'roadcraft-studio/1', kind, name: 'Centro urbano' };
  switch (kind) {
    case 'signal': return { ...base, kind, lanes: 2, width: 3.2, radius: 6, assignments: movements.map(movement => ({ movement, lane: 0, exit: 0 })), phases: [
      { id: 'p1', name: 'Norte–Sul', green: 25, amber: 3, clearance: 1, movements: ['N-S', 'S-N'], crossings: [] },
      { id: 'p2', name: 'Leste–Oeste', green: 25, amber: 3, clearance: 1, movements: ['E-W', 'W-E'], crossings: [] },
    ] };
    case 'traffic': return { ...base, kind, network: defaultNetwork(), flows: [{ id: 'f1', name: 'Estação → Bairro', from: 'a', to: 'd', rate: 240 }], seed: 42, speed: 35, buses: 10, trucks: 15, peakStart: 420, peakEnd: 540, multiplier: 2, start: 420, duration: 600 };
    case 'transit': return { ...base, kind, network: defaultNetwork(), lines: [{ id: 'l1', name: 'Linha 01 · Circular', color: '#4b96bd', stops: ['a', 'b', 'c', 'd', 'e', 'f'], headway: 10, speed: 25, dwell: 20, start: 360, end: 1320, capacity: 70, returnTrip: true }] };
    case 'material': return { ...base, kind, name: 'Asfalto novo', color: '#535859', roughness: 0.88, metalness: 0, scale: 3, wear: 0.2, pattern: 'asphalt', shape: 'sphere', texture: null };
    case 'animation': return { ...base, kind, name: 'Caminhada', duration: 2, loop: true, grounded: true, keys: [0, 0.5, 1, 1.5, 2].map((time, i) => ({ time, pose: { ...neutralPose(), leftArm: i % 2 ? -25 : 25, rightArm: i % 2 ? 25 : -25, leftLeg: i % 2 ? 25 : -25, rightLeg: i % 2 ? -25 : 25, leftKnee: i % 2 ? 25 : 0, rightKnee: i % 2 ? 0 : 25 } })) };
    case 'sound': return { ...base, kind, name: 'Ambiente urbano', listener: { x: 0, y: 0 }, duration: 5, master: 0.35, sources: [{ id: 's1', name: 'Motor distante', x: -12, y: -8, type: 'motor', frequency: 80, volume: 0.3, radius: 40, reference: 2, loop: true, audio: null }] };
  }
}

function demand(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
function obj(value: unknown): Record<string, unknown> { demand(!!value && typeof value === 'object' && !Array.isArray(value), 'Objeto de projeto inválido.'); return value as Record<string, unknown>; }
function str(value: unknown, max = 100): asserts value is string { demand(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'Texto vazio ou longo demais.'); }
function num(value: unknown, min: number, max: number): asserts value is number { demand(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `Número fora do intervalo ${min}–${max}.`); }
function bool(value: unknown): asserts value is boolean { demand(typeof value === 'boolean', 'Valor booleano inválido.'); }
function list(value: unknown, min: number, max: number): unknown[] { demand(Array.isArray(value) && value.length >= min && value.length <= max, 'Quantidade de elementos inválida.'); return value; }
function color(value: unknown) { demand(typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value), 'Cor inválida.'); }
function data(value: unknown, media: 'image' | 'audio') { demand(value === null || (typeof value === 'string' && value.length < 12_000_000 && new RegExp(`^data:${media}/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+$`).test(value)), 'Arquivo incorporado inválido; use um arquivo local.'); }
function point(value: Record<string, unknown>) { num(value.x, -10000, 10000); num(value.y, -10000, 10000); }
function unique(items: unknown[]) { const ids = items.map(item => { const id = obj(item).id; str(id, 80); return id; }); demand(new Set(ids).size === ids.length, 'Identificadores duplicados.'); }
function checkNetwork(value: unknown): Network {
  const net = obj(value), nodes = list(net.nodes, 2, 100), edges = list(net.edges, 0, 300);
  unique(nodes); unique(edges);
  for (const node of nodes) { const n = obj(node); str(n.name); point(n); }
  const ids = new Set(nodes.map(n => obj(n).id));
  for (const edge of edges) { const e = obj(edge); demand(ids.has(e.from) && ids.has(e.to) && e.from !== e.to, 'Via com nó ausente ou extremos iguais.'); num(e.speed, 1, 130); bool(e.both); }
  return value as Network;
}
export function parseProject(text: string, kind: Kind): Project {
  demand(text.length <= 30_000_000, 'Projeto maior que 30 MB.');
  const p = obj(JSON.parse(text) as unknown);
  demand(p.format === 'roadcraft-studio/1' && p.kind === kind, 'Formato incompatível com este editor.'); str(p.name);
  if (kind === 'signal') {
    num(p.lanes, 1, 4); demand(Number.isInteger(p.lanes), 'Faixas devem ser inteiras.'); num(p.width, 2.5, 4.5); num(p.radius, 2, 12);
    const assignments = list(p.assignments, 12, 12);
    demand(new Set(assignments.map(a => obj(a).movement)).size === 12, 'Conversões de faixa duplicadas.');
    for (const item of assignments) { const a = obj(item); demand(movements.includes(a.movement as string), 'Conversão de faixa inválida.'); num(a.lane, 0, (p.lanes as number) - 1); num(a.exit, 0, (p.lanes as number) - 1); demand(Number.isInteger(a.lane) && Number.isInteger(a.exit), 'Índice de faixa inválido.'); }
    const phases = list(p.phases, 1, 24); unique(phases);
    for (const item of phases) { const phase = obj(item); str(phase.name); num(phase.green, 1, 300); num(phase.amber, 0.5, 15); num(phase.clearance, 0.5, 15);
      const moves = list(phase.movements, 0, 12), crossings = list(phase.crossings, 0, 4);
      demand(moves.every(m => typeof m === 'string' && movements.includes(m)) && new Set(moves).size === moves.length, 'Conversões inválidas.');
      demand(crossings.every(s => sides.includes(s as Side)) && new Set(crossings).size === crossings.length, 'Travessias inválidas.');
    }
  } else if (kind === 'traffic' || kind === 'transit') {
    const net = checkNetwork(p.network), ids = new Set(net.nodes.map(n => n.id));
    if (kind === 'traffic') {
      num(p.seed, 1, 1_000_000); num(p.speed, 5, 100); num(p.buses, 0, 100); num(p.trucks, 0, 100); vehicleMix(p.buses as number, p.trucks as number);
      num(p.peakStart, 0, 1439); num(p.peakEnd, 0, 1439); num(p.start, 0, 1439); num(p.multiplier, 1, 5); num(p.duration, 30, 3600);
      const flows = list(p.flows, 1, 24); unique(flows);
      for (const item of flows) { const flow = obj(item); str(flow.name); num(flow.rate, 0, 3600); demand(ids.has(flow.from as string) && ids.has(flow.to as string) && flow.from !== flow.to, 'Origem ou destino inválido.'); }
    } else {
      const lines = list(p.lines, 1, 16); unique(lines);
      for (const item of lines) { const line = obj(item); str(line.name); color(line.color); num(line.headway, 1, 120); num(line.speed, 5, 80); num(line.dwell, 0, 120); num(line.start, 0, 1439); num(line.end, 1, 1440); demand((line.end as number) > (line.start as number), 'O término deve ser depois do início.'); num(line.capacity, 1, 200); bool(line.returnTrip);
        const stops = list(line.stops, 2, 50); demand(stops.every(s => ids.has(s as string)), 'Parada ausente na rede.');
        demand(stops.every((s, i) => i === 0 || s !== stops[i - 1]), 'Paradas consecutivas iguais.');
      }
    }
  } else if (kind === 'material') {
    color(p.color); num(p.roughness, 0, 1); num(p.metalness, 0, 1); num(p.scale, 0.25, 20); num(p.wear, 0, 1);
    demand(['asphalt', 'concrete', 'brick', 'fabric', 'plain'].includes(p.pattern as string), 'Superfície inválida.'); demand(['sphere', 'cube', 'plane'].includes(p.shape as string), 'Forma inválida.'); data(p.texture, 'image');
  } else if (kind === 'animation') {
    num(p.duration, 0.2, 30); bool(p.loop); bool(p.grounded); const keys = list(p.keys, 2, 120);
    let last = -1;
    for (const item of keys) { const key = obj(item); num(key.time, 0, p.duration as number); demand((key.time as number) > last, 'Tempos de quadros devem ser únicos e crescentes.'); last = key.time as number; const pose = obj(key.pose); for (const joint of joints) num(pose[joint], joint === 'height' ? -0.6 : -150, joint === 'height' ? 0.6 : 150); }
    demand(obj(keys[0]).time === 0 && obj(keys[keys.length - 1]).time === p.duration, 'A animação precisa de quadros no início e no fim.');
  } else {
    point(obj(p.listener)); num(p.duration, 1, 30); num(p.master, 0, 1); const sources = list(p.sources, 1, 12); unique(sources);
    for (const item of sources) { const s = obj(item); str(s.name); point(s); demand(['motor', 'wind', 'steps', 'tone', 'file'].includes(s.type as string), 'Tipo de som inválido.'); num(s.frequency, 20, 2000); num(s.volume, 0, 1); num(s.reference, 0.1, 50); num(s.radius, 1, 200); demand((s.reference as number) <= (s.radius as number), 'Distância de referência maior que o alcance.'); bool(s.loop); data(s.audio, 'audio'); demand(s.type !== 'file' || s.audio !== null, 'Fonte de arquivo sem áudio.'); }
  }
  return p as unknown as Project;
}

export const phaseDuration = (phase: Phase) => phase.green + phase.amber + phase.clearance;
export const cycleDuration = (p: SignalProject) => p.phases.reduce((sum, phase) => sum + phaseDuration(phase), 0);
export function phaseAt(p: SignalProject, seconds: number): { index: number; stage: 'green' | 'amber' | 'red'; elapsed: number } {
  let t = ((seconds % cycleDuration(p)) + cycleDuration(p)) % cycleDuration(p);
  for (let index = 0; index < p.phases.length; index++) { const phase = p.phases[index]!; if (t < phaseDuration(phase)) return { index, stage: t < phase.green ? 'green' : t < phase.green + phase.amber ? 'amber' : 'red', elapsed: t }; t -= phaseDuration(phase); }
  return { index: 0, stage: 'green', elapsed: 0 };
}
const directions: Record<Side, Point> = { N: { x: 0, y: -1 }, E: { x: 1, y: 0 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 } };
export function movementPath(id: string, p: SignalProject): Point[] {
  const [from, to] = id.split('-') as [Side, Side], a = directions[from], b = directions[to], assignment = p.assignments.find(item => item.movement === id), offset = p.width * ((assignment?.lane ?? 0) + 0.5), exit = p.width * ((assignment?.exit ?? 0) + 0.5), distance = p.lanes * p.width + 4;
  const start = { x: a.x * distance + a.y * offset, y: a.y * distance - a.x * offset };
  const end = { x: b.x * distance - b.y * exit, y: b.y * distance + b.x * exit };
  const straight = (sides.indexOf(to) - sides.indexOf(from) + 4) % 4 === 2;
  return Array.from({ length: 25 }, (_, i) => { const t = i / 24; return straight ? { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t } : { x: (1 - t) ** 2 * start.x + t ** 2 * end.x, y: (1 - t) ** 2 * start.y + t ** 2 * end.y }; });
}
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
  if (x * y < 0 && z * w < 0) return true;
  const on = (p: Point, q: Point, r: Point) => Math.abs(cross(p, q, r)) < 1e-8 && r.x >= Math.min(p.x, q.x) - 1e-8 && r.x <= Math.max(p.x, q.x) + 1e-8 && r.y >= Math.min(p.y, q.y) - 1e-8 && r.y <= Math.max(p.y, q.y) + 1e-8;
  return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}
export function crossingPath(side: Side, p: SignalProject): Point[] { const d = directions[side], extent = p.lanes * p.width, reach = extent + 2.5; return [{ x: d.x * reach + d.y * extent, y: d.y * reach - d.x * extent }, { x: d.x * reach - d.y * extent, y: d.y * reach + d.x * extent }]; }
export function signalConflicts(p: SignalProject, phase: Phase): string[] {
  const conflicts: string[] = [], paths = phase.movements.map(m => ({ id: m, points: movementPath(m, p) }));
  const overlaps = (a: Point[], b: Point[]) => a.some((point, i) => i > 0 && b.some((other, j) => j > 0 && intersects(a[i - 1]!, point, b[j - 1]!, other)));
  for (let i = 0; i < paths.length; i++) { const a = paths[i]!; for (const b of paths.slice(i + 1)) if (a.id[0] !== b.id[0] && overlaps(a.points, b.points)) conflicts.push(`${a.id} × ${b.id}`); for (const side of phase.crossings) if (overlaps(a.points, crossingPath(side, p))) conflicts.push(`${a.id} × travessia ${sideNames[side]}`); }
  return conflicts;
}
export const nodeById = (network: Network, id: string) => network.nodes.find(n => n.id === id);
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export function shortestRoute(network: Network, from: string, to: string): string[] {
  if (!nodeById(network, from) || !nodeById(network, to)) return [];
  const costs = new Map<string, number>([[from, 0]]), previous = new Map<string, string>(), open = new Set(network.nodes.map(n => n.id));
  while (open.size) { let id: string | undefined, cost = Infinity; for (const candidate of open) if ((costs.get(candidate) ?? Infinity) < cost) { id = candidate; cost = costs.get(candidate)!; } if (!id) break; if (id === to) break; open.delete(id);
    for (const edge of network.edges) { const next = edge.from === id ? edge.to : edge.both && edge.to === id ? edge.from : undefined; if (!next || !open.has(next)) continue; const length = distance(nodeById(network, id)!, nodeById(network, next)!); if (cost + length < (costs.get(next) ?? Infinity)) { costs.set(next, cost + length); previous.set(next, id); } }
  }
  if (!costs.has(to)) return [];
  const result = [to]; while (result[0] !== from) { const before = previous.get(result[0]!); if (!before) return []; result.unshift(before); } return result;
}
export function routeLength(network: Network, route: string[]): number { return route.reduce((sum, id, i) => i ? sum + distance(nodeById(network, route[i - 1]!)!, nodeById(network, id)!) : sum, 0); }
export function movePoint(network: Network, id: string, x: number, y: number): Network { return { nodes: network.nodes.map(n => n.id === id ? { ...n, x, y } : { ...n }), edges: network.edges.map(e => ({ ...e })) }; }
export function demandRate(rate: number, start: number, end: number, multiplier: number, minute: number): number { const t = ((minute % 1440) + 1440) % 1440; return rate * ((start < end ? t >= start && t < end : start > end && (t >= start || t < end)) ? multiplier : 1); }
export function vehicleMix(buses: number, trucks: number) { demand(buses >= 0 && trucks >= 0 && buses + trucks <= 100, 'Ônibus e caminhões juntos devem somar no máximo 100%.'); return { cars: 100 - buses - trucks, buses, trucks }; }
export type Trip = { birth: number; finish: number; route: string[]; seconds: number[]; type: 'car' | 'bus' | 'truck'; length: number };
function seededShare(seed: number, index: number, flow: string): number {
  let value = (seed ^ index) >>> 0;
  for (const char of flow) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  value = Math.imul(value ^ value >>> 16, 0x7feb352d); value = Math.imul(value ^ value >>> 15, 0x846ca68b);
  return ((value ^ value >>> 16) >>> 0) / 4294967296 * 100;
}
export function trafficPlan(p: TrafficProject): Trip[] {
  const trips: Trip[] = [];
  for (const flow of p.flows) {
    const route = shortestRoute(p.network, flow.from, flow.to); if (route.length < 2) continue;
    const seconds = [0];
    for (let i = 1; i < route.length; i++) { const a = route[i - 1]!, b = route[i]!, edge = p.network.edges.find(e => e.from === a && e.to === b || e.both && e.to === a && e.from === b)!; seconds.push(seconds[i - 1]! + distance(nodeById(p.network, a)!, nodeById(p.network, b)!) / (Math.min(p.speed, edge.speed) / 3.6)); }
    let accumulated = 0, emitted = 0;
    for (let t = 1; t <= p.duration; t++) { accumulated += demandRate(flow.rate, p.peakStart, p.peakEnd, p.multiplier, p.start + (t - 1) / 60) / 3600; while (emitted < Math.floor(accumulated + 1e-9)) { const random = seededShare(p.seed, emitted, flow.id); trips.push({ birth: t, finish: t + seconds[seconds.length - 1]!, seconds, route, type: random < p.buses ? 'bus' : random < p.buses + p.trucks ? 'truck' : 'car', length: routeLength(p.network, route) }); emitted++; } }
  }
  return trips.sort((a, b) => a.birth - b.birth);
}
export function routePoint(network: Network, route: string[], seconds: number[], time: number): { point: Point; angle: number } {
  let i = 1; while (i < seconds.length - 1 && time > seconds[i]!) i++;
  const a = nodeById(network, route[i - 1]!)!, b = nodeById(network, route[i]!)!;
  const ratio = Math.max(0, Math.min(1, (time - seconds[i - 1]!) / Math.max(0.001, seconds[i]! - seconds[i - 1]!)));
  return { point: { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}
export function transitSchedule(network: Network, line: Line) {
  const route: string[] = [];
  for (let i = 1; i < line.stops.length; i++) { const leg = shortestRoute(network, line.stops[i - 1]!, line.stops[i]!); demand(leg.length > 0, 'Há paradas desconectadas nesta linha.'); route.push(...(i === 1 ? leg : leg.slice(1))); }
  const length = routeLength(network, route), tripSeconds = length / (line.speed / 3.6) + line.stops.length * line.dwell;
  let returnSeconds = 0;
  if (line.returnTrip) { const reversed = [...line.stops].reverse(); for (let i = 1; i < reversed.length; i++) { const leg = shortestRoute(network, reversed[i - 1]!, reversed[i]!); demand(leg.length > 0, 'O retorno não tem rota na rede.'); returnSeconds += routeLength(network, leg) / (line.speed / 3.6); } returnSeconds += line.stops.length * line.dwell; }
  const cycleSeconds = tripSeconds + returnSeconds;
  return { route, distance: length, tripSeconds, cycleSeconds, fleet: Math.max(1, Math.ceil(cycleSeconds / (line.headway * 60))), departures: Array.from({ length: Math.floor((line.end - line.start) / line.headway) + 1 }, (_, i) => line.start + i * line.headway) };
}
export function interpolatePose(p: AnimationProject, time: number): Pose {
  const t = Math.max(0, Math.min(p.duration, time));
  const after = p.keys.find(k => k.time >= t) ?? p.keys[p.keys.length - 1]!, before = [...p.keys].reverse().find(k => k.time <= t) ?? p.keys[0]!;
  const factor = after.time === before.time ? 0 : (t - before.time) / (after.time - before.time), pose = neutralPose();
  for (const joint of joints) pose[joint] = before.pose[joint] + (after.pose[joint] - before.pose[joint]) * factor;
  return pose;
}
export function resizeClip(p: AnimationProject, duration: number): AnimationProject { num(duration, 0.2, 30); return { ...p, duration, keys: p.keys.map(key => ({ time: key.time / p.duration * duration, pose: { ...key.pose } })) }; }
/** Height needed to support the lowest corner of either rigid shoe on y=0. */
export function supportHeight(pose: Pose): number {
  const foot = (side: 'left' | 'right') => { const hip = pose[`${side}Leg`] * Math.PI / 180, shin = hip + pose[`${side}Knee`] * Math.PI / 180; return -0.08 - 0.38 * Math.cos(hip) - 0.395 * Math.cos(shin) - 0.065 * Math.sin(shin) - 0.045 * Math.abs(Math.cos(shin)) - 0.115 * Math.abs(Math.sin(shin)); };
  return -Math.min(foot('left'), foot('right'));
}
export function animationSamples(p: AnimationProject): Keyframe[] {
  const samples: Keyframe[] = [];
  for (let i = 1; i < p.keys.length; i++) {
    const a = p.keys[i - 1]!, b = p.keys[i]!;
    const angle = Math.max(...joints.filter(j => j !== 'height').map(j => Math.abs(b.pose[j] - a.pose[j])));
    const steps = Math.max(1, Math.ceil((b.time - a.time) * 60), Math.ceil(angle / 20));
    for (let n = i === 1 ? 0 : 1; n <= steps; n++) { const time = n === steps ? b.time : a.time + (b.time - a.time) * n / steps; samples.push({ time, pose: interpolatePose(p, time) }); }
  }
  return samples;
}
/** Character budget bounds embedded-asset snapshots; keep one nearest state. */
export function trimSnapshots(past: string[], future: string[], budget = 16_000_000): void {
  let size = past.concat(future).reduce((sum, text) => sum + text.length, 0);
  while (size > budget && past.length + future.length > 1) { const removed = past.length ? past.shift()! : future.shift()!; size -= removed.length; }
}
export function frameBounds(points: Point[], width: number, height: number, iso: boolean) {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const extentX = Math.max(20, (maxX - minX) / 2 + 18), extentY = Math.max(20, (maxY - minY) / 2 + 18);
  const scale = Math.max(0.0001, Math.min(Math.max(1, width - 50) / ((iso ? (extentX + extentY) * 0.707 : extentX) * 2), Math.max(1, height - 65) / ((iso ? (extentX + extentY) * 0.4 : extentY) * 2)));
  return { center, scale };
}
export function soundGain(dist: number, reference: number, radius: number, volume: number): number { return dist > radius ? 0 : volume * reference / Math.max(reference, dist); }
export function makeWave(channels: Float32Array[], rate: number): ArrayBuffer {
  demand(channels.length > 0 && channels.length <= 2 && channels.every(c => c.length === channels[0]!.length), 'Canais de áudio inválidos.');
  const count = channels[0]!.length, buffer = new ArrayBuffer(44 + count * channels.length * 2), view = new DataView(buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels.length, true); view.setUint32(24, rate, true); view.setUint32(28, rate * channels.length * 2, true); view.setUint16(32, channels.length * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, buffer.byteLength - 44, true);
  for (let i = 0; i < count; i++) for (let c = 0; c < channels.length; c++) { const sample = Math.max(-1, Math.min(1, channels[c]![i]!)); view.setInt16(44 + (i * channels.length + c) * 2, Math.trunc(sample * (sample < 0 ? 32768 : 32767)), true); }
  return buffer;
}
