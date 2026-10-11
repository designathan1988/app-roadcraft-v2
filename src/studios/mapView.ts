import { movementPath, crossingPath, sides, phaseAt, signalConflicts, shortestRoute, nodeById, trafficPlan, routePoint, transitSchedule, distance, frameBounds } from './model';
import type { Project, SignalProject, Network, Point, Trip, TrafficProject, TransitProject, SoundProject } from './model';

export type MapCallbacks = { pick: (id: string) => void; move: (id: string, point: Point) => void; add: (point: Point) => void };
export class MapView {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private project: Project;
  private selection = '';
  private t = 0;
  private width = 1;
  private height = 1;
  private scale = 1;
  private iso = false;
  private center: Point = { x: 0, y: 0 };
  private dragging: { id: string; point: Point } | null = null;
  private trips: Trip[] = [];
  tool: 'select' | 'add' | 'connect' = 'select';
  constructor(private host: HTMLElement, project: Project, private callbacks: MapCallbacks) {
    this.project = project;
    const ctx = this.canvas.getContext('2d'); if (!ctx) throw new Error('Canvas 2D indisponível.'); this.ctx = ctx;
    this.canvas.tabIndex = 0; this.canvas.setAttribute('aria-label', 'Prévia interativa. Os pontos também podem ser editados nos campos de coordenadas.');
    host.append(this.canvas);
    this.canvas.addEventListener('pointerdown', e => this.down(e));
    this.canvas.addEventListener('pointermove', e => { if (this.dragging) { this.dragging.point = this.toWorld(e); this.draw(); } });
    this.canvas.addEventListener('pointerup', e => { if (this.dragging) { const move = this.dragging; this.dragging = null; this.callbacks.move(move.id, move.point); } if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointercancel', () => { this.dragging = null; this.draw(); });
    new ResizeObserver(() => this.resize()).observe(host);
    this.update(project, '', 0); this.resize();
  }
  setMode(iso: boolean) { this.iso = iso; this.resize(); }
  update(project: Project, selection: string, time: number) { const changed = project !== this.project; this.project = project; this.selection = selection; this.t = time; if (changed && project.kind === 'traffic' || !this.trips.length && project.kind === 'traffic') this.trips = trafficPlan(project as TrafficProject); if (changed) this.resize(); else this.draw(); }
  tick(time: number) { this.t = time; this.draw(); }
  metrics(time = this.t) { const departed = this.trips.filter(v => v.birth <= time), completed = departed.filter(v => v.finish <= time); return { departed: departed.length, completed: completed.length, active: departed.length - completed.length, average: completed.length ? completed.reduce((s, v) => s + v.finish - v.birth, 0) / completed.length : 0 }; }
  private points(): (Point & { id: string; name: string })[] {
    const p = this.project;
    if (p.kind === 'traffic' || p.kind === 'transit') return p.network.nodes;
    if (p.kind === 'sound') return [...p.sources, { ...p.listener, id: 'listener', name: 'Ouvinte' }];
    return [];
  }
  private at(point: Point): Point { const drag = this.dragging; return drag && drag.id === ('id' in point ? point.id : '') ? drag.point : point; }
  private screen(point: Point): Point { const p = this.at(point), x = p.x - this.center.x, y = p.y - this.center.y; return { x: this.width / 2 + (this.iso ? (x - y) * 0.707 : x) * this.scale, y: this.height / 2 + (this.iso ? (x + y) * 0.4 : y) * this.scale }; }
  private toWorld(e: PointerEvent): Point { const box = this.canvas.getBoundingClientRect(), x = (e.clientX - box.left - this.width / 2) / this.scale, y = (e.clientY - box.top - this.height / 2) / this.scale; return this.iso ? { x: this.center.x + (x / 0.707 + y / 0.4) / 2, y: this.center.y + (y / 0.4 - x / 0.707) / 2 } : { x: this.center.x + x, y: this.center.y + y }; }
  private down(e: PointerEvent) {
    if (this.project.kind === 'signal') return;
    const point = this.toWorld(e), closest = this.points().find(p => distance(p, point) * this.scale < 15);
    if (closest) { this.callbacks.pick(closest.id); if (this.tool === 'select') { this.dragging = { id: closest.id, point: { x: closest.x, y: closest.y } }; this.canvas.setPointerCapture(e.pointerId); } }
    else if (this.tool === 'add') this.callbacks.add({ x: Math.round(point.x), y: Math.round(point.y) });
  }
  private resize() {
    this.width = this.host.clientWidth; this.height = this.host.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio); this.canvas.width = Math.round(this.width * dpr); this.canvas.height = Math.round(this.height * dpr); this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let points: Point[] = this.points();
    if (this.project.kind === 'signal') points = [{ x: -10, y: -10 }, { x: 10, y: 10 }];
    if (this.project.kind === 'sound') points = [this.project.listener, ...this.project.sources.flatMap(s => [{ x: s.x - s.radius, y: s.y - s.radius }, { x: s.x + s.radius, y: s.y + s.radius }])];
    const bounds = frameBounds(points, this.width, this.height, this.iso); this.center = bounds.center; this.scale = bounds.scale;
    this.draw();
  }
  private line(points: Point[], color: string, width: number, dash: number[] = []) { const c = this.ctx; c.beginPath(); points.forEach((p, i) => { const s = this.screen(p); if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y); }); c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round'; c.setLineDash(dash); c.stroke(); c.setLineDash([]); }
  private dot(point: Point, color: string, radius = 5) { const s = this.screen(point), c = this.ctx; c.beginPath(); c.arc(s.x, s.y, radius, 0, Math.PI * 2); c.fillStyle = color; c.fill(); }
  private label(point: Point, text: string, color = '#425343') { const s = this.screen(point); this.ctx.font = '12px "Segoe UI", sans-serif'; this.ctx.textAlign = 'center'; this.ctx.fillStyle = color; this.ctx.fillText(text, s.x, s.y + 23); }
  private draw() {
    const c = this.ctx; c.clearRect(0, 0, this.width, this.height); c.fillStyle = '#edf1e7'; c.fillRect(0, 0, this.width, this.height);
    for (let x = -180; x <= 180; x += 10) this.line([{ x, y: -180 }, { x, y: 180 }], '#dfe6d9', 0.7);
    for (let y = -180; y <= 180; y += 10) this.line([{ x: -180, y }, { x: 180, y }], '#dfe6d9', 0.7);
    const p = this.project;
    if (p.kind === 'signal') this.junction(p);
    else if (p.kind === 'traffic' || p.kind === 'transit') { this.network(p.network); for (const node of p.network.nodes) { this.dot(node, '#fafbf8', node.id === this.selection ? 10 : 7); this.dot(node, node.id === this.selection ? '#659d39' : '#687d6b', 4); this.label(node, node.name); } if (p.kind === 'traffic') this.traffic(p); else this.transit(p); }
    else if (p.kind === 'sound') this.sound(p);
    c.fillStyle = '#75816f'; c.font = '11px "Segoe UI", sans-serif'; c.textAlign = 'right'; c.fillText('metros · X leste / Y sul', this.width - 14, 22);
  }
  private junction(p: SignalProject) {
    const c = this.ctx, h = p.lanes * p.width, r = p.radius;
    // A concave fillet joins each approach to the junction; all measures are metres.
    const cross = (half: number, radius: number, color: string) => {
      const reach = 48, points = [
        [-reach, -half], [-half - radius, -half], [-half, -half], [-half, -half - radius], [-half, -reach], [half, -reach], [half, -half - radius], [half, -half], [half + radius, -half], [reach, -half], [reach, half], [half + radius, half], [half, half], [half, half + radius], [half, reach], [-half, reach], [-half, half + radius], [-half, half], [-half - radius, half], [-reach, half],
      ];
      c.beginPath(); const start = this.screen({ x: points[0]![0]!, y: points[0]![1]! }); c.moveTo(start.x, start.y);
      for (let i = 1; i < points.length; i++) { const s = this.screen({ x: points[i]![0]!, y: points[i]![1]! }); if ([2, 7, 12, 17].includes(i)) { const next = this.screen({ x: points[i + 1]![0]!, y: points[i + 1]![1]! }); c.quadraticCurveTo(s.x, s.y, next.x, next.y); i++; } else c.lineTo(s.x, s.y); } c.closePath(); c.fillStyle = color; c.fill();
    };
    cross(h + 3, r, '#d5d0c4'); cross(h, r, '#515a59');
    for (const side of sides) { const vertical = side === 'N' || side === 'S', sign = side === 'N' || side === 'W' ? -1 : 1;
      for (let lane = -p.lanes + 1; lane < p.lanes; lane++) { const offset = lane * p.width; const from = vertical ? { x: offset, y: sign * (h + r + 5) } : { x: sign * (h + r + 5), y: offset }, to = vertical ? { x: offset, y: sign * 48 } : { x: sign * 48, y: offset }; this.line([from, to], '#dfe3dd', lane === 0 ? 1.4 : 1, lane === 0 ? [] : [8, 8]); }
      for (let stripe = -h + 0.4; stripe < h; stripe += 1.4) this.line(vertical ? [{ x: stripe, y: sign * (h + 1.7) }, { x: stripe, y: sign * (h + 3.4) }] : [{ x: sign * (h + 1.7), y: stripe }, { x: sign * (h + 3.4), y: stripe }], '#eef0e9', Math.max(2, this.scale * 0.6));
    }
    const active = phaseAt(p, this.t), phase = p.phases[active.index]!, selected = p.phases.find(v => v.id === this.selection) ?? phase;
    const conflicting = signalConflicts(p, selected);
    for (const m of selected.movements) { const path = movementPath(m, p); this.line(path, conflicting.some(v => v.includes(m)) ? '#cd6a51' : '#8bbf48', 2.4, [5, 5]); }
    for (const side of selected.crossings) this.line(crossingPath(side, p), '#4b96bd', 4);
    for (const side of sides) { const path = movementPath(`${side}-${sides[(sides.indexOf(side) + 2) % 4]!}`, p), first = path[0]!; this.dot({ x: first.x + (side === 'N' || side === 'S' ? 3 : 0), y: first.y + (side === 'E' || side === 'W' ? 3 : 0) }, phase.movements.some(m => m.startsWith(side)) ? active.stage === 'green' ? '#8bbf48' : active.stage === 'amber' ? '#e5b653' : '#ce6858' : '#ce6858', 5); }
    if (active.stage === 'green') for (const m of phase.movements) { const path = movementPath(m, p), progress = (this.t * 0.18 + sides.indexOf(m[0] as typeof sides[number]) * 0.2) % 1, a = path[Math.floor(progress * (path.length - 1))]!; this.dot(a, '#70bad6', 4); }
    const s = this.screen({ x: 0, y: -32 }); c.fillStyle = '#36473c'; c.textAlign = 'center'; c.font = '12px "Segoe UI",sans-serif'; c.fillText(`${phase.name} · ${active.stage === 'green' ? 'verde' : active.stage === 'amber' ? 'amarelo' : 'vermelho geral'}`, s.x, s.y - 12);
  }
  private network(net: Network) {
    for (const edge of net.edges) { const a = nodeById(net, edge.from)!, b = nodeById(net, edge.to)!; this.line([a, b], '#d1cec0', Math.max(10, this.scale * 9)); this.line([a, b], '#68716e', Math.max(7, this.scale * 6)); this.line([a, b], '#e5e8dc', 1, [8, 10]); if (!edge.both) { const x = this.screen(a), y = this.screen(b), angle = Math.atan2(y.y - x.y, y.x - x.x), center = { x: (x.x + y.x) / 2, y: (x.y + y.y) / 2 }; this.ctx.save(); this.ctx.translate(center.x, center.y); this.ctx.rotate(angle); this.ctx.fillStyle = '#eff2e7'; this.ctx.beginPath(); this.ctx.moveTo(7, 0); this.ctx.lineTo(-5, -4); this.ctx.lineTo(-5, 4); this.ctx.fill(); this.ctx.restore(); } }
  }
  private vehicle(point: Point, angle: number, color: string, long = false) { const s = this.screen(point), c = this.ctx; c.save(); c.translate(s.x, s.y); c.rotate(this.iso ? Math.atan2(Math.sin(angle) * 0.4 + Math.cos(angle) * 0.4, Math.cos(angle) * 0.707 - Math.sin(angle) * 0.707) : angle); c.fillStyle = '#283933'; c.fillRect(-8, -4, long ? 20 : 13, 8); c.fillStyle = color; c.fillRect(-7, -3, long ? 18 : 11, 6); c.fillStyle = '#afc8cf'; c.fillRect(1, -2.5, 3, 5); c.restore(); }
  private traffic(p: TrafficProject) {
    const flow = p.flows.find(f => f.id === this.selection) ?? p.flows[0];
    if (flow) { const route = shortestRoute(p.network, flow.from, flow.to); this.line(route.map(id => nodeById(p.network, id)!), '#8bbf48', 3); }
    let visible = 0; for (const trip of this.trips) { if (trip.birth > this.t) break; if (trip.finish < this.t) continue; const location = routePoint(p.network, trip.route, trip.seconds, this.t - trip.birth); this.vehicle(location.point, location.angle, trip.type === 'bus' ? '#4b96bd' : trip.type === 'truck' ? '#b88c63' : '#a1c26a', trip.type !== 'car'); if (++visible >= 300) break; }
  }
  private transit(p: TransitProject) {
    for (const line of p.lines) { let schedule: ReturnType<typeof transitSchedule>; try { schedule = transitSchedule(p.network, line); } catch (error) { this.ctx.fillStyle = '#a04b34'; this.ctx.textAlign = 'left'; this.ctx.font = '12px "Segoe UI",sans-serif'; this.ctx.fillText(`${line.name}: ${error instanceof Error ? error.message : String(error)}`, 15, 42 + p.lines.indexOf(line) * 18); continue; }
      this.line(schedule.route.map(id => nodeById(p.network, id)!), line.color, line.id === this.selection ? 4 : 2);
      for (const [index, id] of line.stops.entries()) { const node = nodeById(p.network, id)!; this.dot(node, line.color, 9); const s = this.screen(node); this.ctx.fillStyle = '#fff'; this.ctx.font = '10px "Segoe UI",sans-serif'; this.ctx.textAlign = 'center'; this.ctx.fillText(String(index + 1), s.x, s.y + 3); }
      // Dwell is represented at every chosen stop; intermediate road nodes are travelled through.
      let elapsed = Math.min(this.t, schedule.tripSeconds), point = nodeById(p.network, line.stops[0]!)!, angle = 0;
      outer: for (let i = 0; i < line.stops.length; i++) { if (elapsed < line.dwell) { point = nodeById(p.network, line.stops[i]!)!; break; } elapsed -= line.dwell; if (i === line.stops.length - 1) break;
        const route = shortestRoute(p.network, line.stops[i]!, line.stops[i + 1]!);
        for (let j = 1; j < route.length; j++) { const a = nodeById(p.network, route[j - 1]!)!, b = nodeById(p.network, route[j]!)!, duration = distance(a, b) / (line.speed / 3.6); if (elapsed < duration) { const t = duration > 0 ? elapsed / duration : 0; point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, id: '', name: '' }; angle = Math.atan2(b.y - a.y, b.x - a.x); break outer; } elapsed -= duration; point = b; }
      }
      this.vehicle(point, angle, line.color, true);
    }
  }
  private sound(p: SoundProject) {
    const c = this.ctx;
    for (const source of p.sources) { const s = this.screen(source), selected = source.id === this.selection; c.save(); c.translate(s.x, s.y); if (this.iso) c.scale(1, 0.56); c.beginPath(); c.arc(0, 0, source.radius * this.scale, 0, 2 * Math.PI); c.fillStyle = selected ? '#8bbf481c' : '#4b96bd0c'; c.fill(); c.strokeStyle = selected ? '#91ac70' : '#b1c2ac'; c.lineWidth = 1; c.stroke(); c.restore(); this.dot(source, selected ? '#659d39' : '#4b96bd', 8); this.label(source, source.name); }
    const listener = { ...p.listener, id: 'listener' }; this.dot(listener, '#202e27', 10); const s = this.screen(listener); c.fillStyle = '#fff'; c.font = '12px "Segoe UI",sans-serif'; c.textAlign = 'center'; c.fillText('◉', s.x, s.y + 4); this.label(listener, 'Ouvinte');
  }
}
