import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, parseProject, phaseAt, shortestRoute, makeWave } from '../../src/studios/model.ts';

test('all six editable formats round-trip and reject another editor', () => {
  for (const kind of ['signal', 'traffic', 'transit', 'material', 'animation', 'sound']) {
    const original = createProject(kind);
    assert.deepEqual(parseProject(JSON.stringify(original), kind), original);
  }
  assert.throws(() => parseProject(JSON.stringify(createProject('sound')), 'signal'));
});
test('a signal programme actually visits green, amber and clearance in order', () => {
  const project = createProject('signal');
  assert.equal(phaseAt(project, 25).stage, 'amber');
  assert.equal(phaseAt(project, 28).stage, 'red');
  assert.equal(phaseAt(project, 29).index, 1);
});
test('a one-way street does not route backwards', () => {
  const graph = {
    nodes: [{ id: 'a', name: 'A', x: 0, y: 0 }, { id: 'b', name: 'B', x: 10, y: 0 }],
    edges: [{ id: 'ab', from: 'a', to: 'b', speed: 30, both: false }],
  };
  assert.deepEqual(shortestRoute(graph, 'a', 'b'), ['a', 'b']);
  assert.deepEqual(shortestRoute(graph, 'b', 'a'), []);
});
test('stereo WAV includes the requested sample rate and interleaved samples', () => {
  const view = new DataView(makeWave([Float32Array.from([1]), Float32Array.from([-1])], 8000));
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});
