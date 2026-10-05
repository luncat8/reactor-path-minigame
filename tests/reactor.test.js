'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Reactor, DT, circleFraction, reflect, guidanceRamp } = require('../js/reactor.js');
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≠ ${b}`);

test('circle dwell handles crossing, partial crossing, stationary, and tangent segments', () => {
	near(circleFraction(-2, 0, 2, 0, 0, 0, 1), 0.5);
	near(circleFraction(0, 0, 2, 0, 0, 0, 1), 0.5);
	near(circleFraction(0, 0, 0, 0, 0, 0, 1), 1);
	near(circleFraction(2, 0, 2, 0, 0, 0, 1), 0);
	near(circleFraction(-2, 1, 2, 1, 0, 0, 1), 0);
});

test('dwell uses timestamp intervals rather than sample counts', () => {
	const sim = new Reactor();
	sim.path.count = 3;
	sim.path.x.set([-2, 0, 2]); sim.path.y.fill(0); sim.path.t.set([4, 5, 8]);
	near(sim.pathDwell({ x: 0, y: 0, radius: 1 }), 2);
});

test('forecast starts at live state, has monotonic absolute timestamps, and never mutates particle', () => {
	const sim = new Reactor();
	for (let i = 0; i < 80; i++) sim.step();
	const before = { ...sim.particle };
	sim.predict();
	assert.deepEqual(sim.particle, before);
	near(sim.path.x[0], before.x); near(sim.path.y[0], before.y); near(sim.path.t[0], sim.time);
	near(sim.path.t[sim.path.count - 1] - sim.path.t[0], 14);
	for (let i = 1; i < sim.path.count; i++) assert.ok(sim.path.t[i] > sim.path.t[i - 1]);
	for (const target of sim.targets) assert.ok(target.predicted >= 0 && target.predicted <= 1);
});

test('grazing crossings reflect, steep impacts and misses pass through', () => {
	const r = { x: 0, y: 0, angle: 0, length: 100 };
	const p = { x: 10, y: 1, vx: 100, vy: 20 };
	assert.equal(reflect(p, 0, -1, 0.1, r), true);
	near(p.vx, 100); near(p.vy, -20); near(p.y, -1);
	near(Math.hypot(p.vx, p.vy), Math.hypot(100, 20));
	const steep = { x: 0, y: 1, vx: 0, vy: 20 };
	assert.equal(reflect(steep, 0, -1, 0.1, r), false);
	const miss = { x: 80, y: 1, vx: 100, vy: 20 };
	assert.equal(reflect(miss, 70, -1, 0.1, r), false);
});

test('integrator reflects a swept grazing hit and the default forecast visibly uses R2', () => {
	const sim = new Reactor();
	sim.magnets.forEach(magnet => { magnet.strength = 0; });
	sim.reflectors = [{ x: 0, y: 0, angle: 0, length: 100 }];
	const p = { x: 0, y: -0.01, vx: 145, vy: 30 };
	sim.integrate(p, DT, { count: 0 }, 0);
	assert.ok(p.vy < 0 && p.y < 0);

	const reflected = new Reactor(), unobstructed = new Reactor();
	reflected.guideStrength = unobstructed.guideStrength = 0;
	unobstructed.reflectors.length = 0;
	reflected.predict(); unobstructed.predict();
	let largestDifference = 0;
	for (let i = 0; i < reflected.path.count; i++) {
		largestDifference = Math.max(largestDifference,
			Math.hypot(reflected.path.x[i] - unobstructed.path.x[i], reflected.path.y[i] - unobstructed.path.y[i]));
	}
	assert.ok(largestDifference > 20, 'default R2 should create a clear forecast bounce');
	for (let i = 0; i < 120 * 8; i++) { reflected.step(); unobstructed.step(); }
	assert.ok(Math.hypot(reflected.particle.x - unobstructed.particle.x, reflected.particle.y - unobstructed.particle.y) > 20,
		'default R2 should change the live particle path');
});

test('simulation is deterministic and reset restores the initial prediction', () => {
	const a = new Reactor(), b = new Reactor();
	const initial = Array.from(a.path.x);
	for (let i = 0; i < 720; i++) { a.step(); b.step(); }
	assert.deepEqual(a.particle, b.particle);
	assert.deepEqual(a.path, b.path);
	a.reset();
	assert.deepEqual(Array.from(a.path.x), initial);
	near(a.time, 0); near(a.cooling, 0); near(a.trailCount, 0);
});

test('magnet position, orientation, and polarity influence forecasts', () => {
	const a = new Reactor(), b = new Reactor();
	b.magnets[0].polarity *= -1; b.magnets[0].angle += 0.6; b.magnets[0].x += 150;
	a.predict(); b.predict();
	assert.ok(Math.hypot(a.path.x[200] - b.path.x[200], a.path.y[200] - b.path.y[200]) > 1);
});

test('guidance is a bounded acceleration gated by forward direction', () => {
	const sim = new Reactor();
	sim.magnets.forEach(magnet => { magnet.strength = 0; });
	sim.reflectors.length = 0;
	const guide = { count: 2, x: [0, 100], y: [0, 0] };
	const noGuide = { count: 0 };
	const effect = (vx, vy) => {
		const guided = { x: 50, y: 10, vx, vy };
		const plain = { ...guided };
		sim.integrate(guided, DT, guide, 1);
		sim.integrate(plain, DT, noGuide, 0);
		return Math.hypot(guided.vx - plain.vx, guided.vy - plain.vy);
	};
	const aligned = effect(100, 0);
	assert.ok(aligned > 0.00001 && aligned < 2);
	assert.equal(effect(-100, 0), 0);
	assert.equal(effect(0, 100), 0);
	assert.ok(effect(1, 100) < aligned * 0.01, 'near-perpendicular motion should receive almost no guide force');
	assert.ok(effect(86.6, 50) > 0, 'partly aligned motion may receive a guide force');
});

test('trajectory guidance aims at the look-ahead node from the single nearest node', () => {
	const sim = new Reactor();
	sim.magnets.forEach(magnet => { magnet.strength = 0; });
	sim.reflectors.length = 0;
	const guide = { count: 11, x: Float64Array.from({ length: 11 }, (_, i) => i * 10), y: new Float64Array(11) };
	const particle = { x: 10, y: 10, vx: 100, vy: 0 };
	const force = sim.guidanceVector(particle, guide, 1);
	assert.ok(force.x > 0 && force.y < 0);
	near(force.y / force.x, -0.25);

	sim.guideLookahead = 200;
	const fartherTarget = sim.guidanceVector(particle, guide, 1);
	near(fartherTarget.y / fartherTarget.x, -0.125);
});

test('distance and direction falloffs gate guidance smoothly', () => {
	const sim = new Reactor();
	const guide = { count: 11, x: Float64Array.from({ length: 11 }, (_, i) => i * 10), y: new Float64Array(11) };
	const forceAt = (y, vx, vy) => sim.guidanceVector({ x: 10, y, vx, vy }, guide, 1);
	const onPath = { ...forceAt(0, 100, 0) };
	const halfway = { ...forceAt(50, 100, 0) };
	assert.ok(Math.hypot(halfway.x, halfway.y) > 0);
	assert.ok(Math.hypot(halfway.x, halfway.y) < Math.hypot(onPath.x, onPath.y));
	assert.deepEqual(forceAt(100, 100, 0), { x: 0, y: 0 });

	const halfAngle = forceAt(10, Math.SQRT1_2 * 100, Math.SQRT1_2 * 100);
	near(Math.hypot(halfAngle.x, halfAngle.y), Math.hypot(forceAt(10, 100, 0).x, forceAt(10, 100, 0).y) * 0.5);
	assert.deepEqual(forceAt(10, 0, 100), { x: 0, y: 0 });
	assert.deepEqual(forceAt(10, -100, 0), { x: 0, y: 0 });

	sim.guideDirection = 45;
	assert.deepEqual(forceAt(10, Math.SQRT1_2 * 100, Math.SQRT1_2 * 100), { x: 0, y: 0 });
});

test('forecast guidance is delayed for two seconds and fades in smoothly over one', () => {
	near(guidanceRamp(0), 0); near(guidanceRamp(2), 0);
	near(guidanceRamp(2.5), 0.5); near(guidanceRamp(3), 1); near(guidanceRamp(14), 1);
	const sim = new Reactor();
	sim.predict();
	for (let i = 0; i <= 80; i++) {
		near(sim.path.forceX[i], 0); near(sim.path.forceY[i], 0);
	}
	assert.ok(Math.hypot(sim.path.forceX[120], sim.path.forceY[120]) > 0, 'force is active by the three-second mark');
});

test('long runs remain finite and bounded across field settings', () => {
	for (const strength of [0, 1, 2]) {
		const sim = new Reactor();
		sim.guideStrength = strength === 2 ? 1.5 : strength;
		for (const m of sim.magnets) m.strength = strength;
		for (let i = 0; i < 120 * 120; i++) {
			sim.step();
			assert.ok(Number.isFinite(sim.particle.vx) && Number.isFinite(sim.particle.vy));
			assert.ok(Math.abs(sim.particle.x) < 500 && Math.abs(sim.particle.y) < 400);
		}
	}
});

test('targets and cooling zones do not alter the particle dynamics', () => {
	const a = new Reactor(), b = new Reactor();
	b.targets.length = 0; b.zones.length = 0;
	for (let i = 0; i < 300; i++) { a.step(); b.step(); }
	assert.deepEqual(a.particle, b.particle);
});
