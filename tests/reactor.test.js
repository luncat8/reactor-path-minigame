'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Reactor, DT, circleFraction, reflect } = require('../js/reactor.js');
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≠ ${b}`);
const FORECAST_TOLERANCE = 0.02;

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


// Synthetic trajectory states are [x, y, absolute time, vx, vy].
function makeRoute(states) {
	const count = states.length;
	const route = {
		count,
		x: new Float64Array(count), y: new Float64Array(count),
		vx: new Float64Array(count), vy: new Float64Array(count), t: new Float64Array(count)
	};
	for (let i = 0; i < count; i++) {
		route.x[i] = states[i][0]; route.y[i] = states[i][1]; route.t[i] = states[i][2];
		route.vx[i] = states[i][3]; route.vy[i] = states[i][4];
	}
	return route;
}

const targetState = () => ({
	segment: -1, x: 0, y: 0, vx: 0, vy: 0, time: 0, lead: 0,
	distance: 0, angle: 0, speedError: 0, timeFactor: 0, score: Infinity
});

function horizontalRoute(y = 0, speed = 100) {
	return makeRoute([[0, y, 3, speed, 0], [100, y, 4, speed, 0]]);
}

test('guide target is interpolated on a segment rather than snapped to a sample', () => {
	const sim = new Reactor();
	const target = targetState();
	const found = sim.findGuideTarget({ x: 20, y: 8, vx: 100, vy: 0 }, horizontalRoute(), 0, target);
	assert.equal(found, true);
	near(target.x, 20);
	near(target.y, 0);
	near(target.distance, 8);
	near(target.vx, 100);
	near(target.vy, 0);
	assert.ok(target.lead >= sim.guideDelay + 1, 'the selected state has completed the one-second fade');
});

test('the near future is excluded and the target is always later than the query', () => {
	const sim = new Reactor();
	sim.guideDelay = 2;
	const route = makeRoute([
		[0, 0, -2, 100, 0], [20, 0, -1, 100, 0],
		[80, 30, 2.1, 100, 0], [120, 30, 4, 100, 0]
	]);
	const target = targetState();
	assert.equal(sim.findGuideTarget({ x: 10, y: 2, vx: 100, vy: 0 }, route, 0, target), true);
	assert.ok(target.time > 2, `target time ${target.time} must be beyond the excluded future`);
	assert.ok(target.y > 10, 'a geometrically closer past segment must not be selected');
});

test('phase-space selection rejects a closer crossing with the wrong movement', () => {
	const sim = new Reactor();
	const route = makeRoute([
		[-20, 1, 3, -100, 0], [20, 1, 4, -100, 0],
		[-20, 8, 5, 100, 0], [20, 8, 6, 100, 0]
	]);
	const target = targetState();
	assert.equal(sim.findGuideTarget({ x: 0, y: 0, vx: 100, vy: 0 }, route, 0, target), true);
	near(target.y, 8);
	assert.equal(target.segment, 2);
	near(target.angle, 0);
});

test('phase-space score can prefer matching speed over a spatially closer pass', () => {
	const sim = new Reactor();
	const route = makeRoute([
		[-20, 1, 3, 300, 0], [20, 1, 4, 300, 0],
		[-20, 10, 5, 100, 0], [20, 10, 6, 100, 0]
	]);
	const target = targetState();
	sim.findGuideTarget({ x: 0, y: 0, vx: 100, vy: 0 }, route, 0, target);
	near(target.y, 10);
	near(target.speedError, 0);
});

test('opposing and perpendicular trajectory passes never guide the particle', () => {
	const sim = new Reactor();
	const opposing = makeRoute([[0, 0, 3, -100, 0], [100, 0, 4, -100, 0]]);
	const perpendicular = makeRoute([[0, 0, 3, 0, 100], [100, 0, 4, 0, 100]]);
	const particle = { x: 20, y: 10, vx: 100, vy: 0 };
	assert.equal(sim.findGuideTarget(particle, opposing, 0, targetState()), false);
	assert.equal(sim.findGuideTarget(particle, perpendicular, 0, targetState()), false);
	near(Math.hypot(...Object.values(sim.guidanceVector(particle, opposing, 0, 1, {}))), 0);
});

test('position matching pulls toward the green target and is idle in the target state', () => {
	const sim = new Reactor();
	const route = horizontalRoute();
	const debug = {};
	const force = sim.guidanceVector({ x: 20, y: 20, vx: 100, vy: 0 }, route, 0, 1, debug);
	near(force.x, 0);
	assert.ok(force.y < 0);
	near(debug.tx, 20); near(debug.ty, 0);
	near(debug.tvx, 100); near(debug.tvy, 0);
	const idle = sim.guidanceVector({ x: 20, y: 0, vx: 100, vy: 0 }, route, 0, 1, {});
	near(idle.x, 0); near(idle.y, 0);
});

test('movement matching changes velocity even when position already matches', () => {
	const sim = new Reactor();
	const route = makeRoute([[0, 0, 3, 100, 30], [100, 0, 4, 100, 30]]);
	const debug = {};
	const force = sim.guidanceVector({ x: 20, y: 0, vx: 100, vy: 0 }, route, 0, 1, debug);
	near(force.x, 0);
	assert.ok(force.y > 0, 'force should turn the particle toward the target movement vector');
	near(debug.distance, 0);
	near(debug.speedError, 30);
});

test('distance and heading controls smoothly fade the state-matching force', () => {
	const sim = new Reactor();
	sim.guideVelocity = 0;
	const route = horizontalRoute();
	const magnitude = (offset, degrees) => {
		const angle = degrees * Math.PI / 180;
		const force = sim.guidanceVector({ x: 20, y: offset, vx: Math.cos(angle) * 100, vy: Math.sin(angle) * 100 }, route, 0, 1, {});
		return Math.hypot(force.x, force.y);
	};
	const near20 = magnitude(20, 0);
	assert.ok(near20 > 0);
	assert.ok(magnitude(90, 0) < near20);
	near(magnitude(100, 0), 0);
	assert.ok(magnitude(20, 60) < near20);
	near(magnitude(20, 90), 0);
	sim.guideDirection = 45;
	near(magnitude(20, 45), 0);
});

test('the one-second temporal fade applies after the excluded future', () => {
	const sim = new Reactor();
	sim.guideDelay = 2;
	const route = makeRoute([[0, 0, 2.5, 100, 0], [0.01, 0, 2.51, 100, 0]]);
	const target = targetState();
	assert.equal(sim.findGuideTarget({ x: 0, y: 10, vx: 100, vy: 0 }, route, 0, target), true);
	assert.ok(target.timeFactor > 0 && target.timeFactor < 1);
	near(target.timeFactor, 0.5, 0.02);
});

test('debug target, movement vectors, and live force describe one current state', () => {
	const sim = new Reactor();
	for (let i = 0; i < 120; i++) sim.step();
	const d = sim.liveDebug;
	assert.ok(d.target >= 0);
	assert.ok(d.lead > sim.guideDelay);
	near(Math.hypot(d.tx - sim.particle.x, d.ty - sim.particle.y), d.distance, 1e-6);
	assert.ok(Number.isFinite(d.tvx) && Number.isFinite(d.tvy));
	near(Math.hypot(sim.liveForce.x, sim.liveForce.y), d.magnitude, 1e-9);
});

test('forecast stores movement states and force samples without mutating live state', () => {
	const sim = new Reactor();
	const before = { ...sim.particle };
	sim.predict();
	assert.deepEqual(sim.particle, before);
	for (let i = 0; i < sim.path.count; i++) {
		assert.ok(Number.isFinite(sim.path.vx[i]) && Number.isFinite(sim.path.vy[i]));
		assert.ok(Number.isFinite(sim.path.forceX[i]) && Number.isFinite(sim.path.forceY[i]));
	}
	near(sim.path.vx[0], before.vx);
	near(sim.path.vy[0], before.vy);
});

test('forecast refresh keeps target time in the future rather than retaining past nodes', () => {
	const sim = new Reactor();
	for (let i = 0; i < 120 * 8; i++) {
		sim.step();
		if (sim.liveDebug.target < 0) continue;
		assert.ok(sim.path.t[sim.liveDebug.target + 1] > sim.time + sim.guideDelay);
		assert.ok(sim.liveDebug.lead > sim.guideDelay);
	}
});

test('long runs remain finite and bounded across guide settings', () => {
	for (const strength of [0, 1.5]) {
		for (const delay of [1, 3]) {
			const sim = new Reactor();
			sim.guideStrength = strength;
			sim.guideDelay = delay;
			for (let i = 0; i < 120 * 20; i++) {
				sim.step();
				assert.ok(Number.isFinite(sim.particle.vx) && Number.isFinite(sim.particle.vy));
				assert.ok(Math.abs(sim.particle.x) < 500 && Math.abs(sim.particle.y) < 400);
			}
		}
	}
});

test('targets and cooling zones do not alter particle dynamics', () => {
	const a = new Reactor(), b = new Reactor();
	b.targets.length = 0; b.zones.length = 0;
	for (let i = 0; i < 300; i++) { a.step(); b.step(); }
	assert.deepEqual(a.particle, b.particle);
});
