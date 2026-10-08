'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Reactor, DT, TAU, circleFraction, reflect } = require('../js/reactor.js');
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


// Synthetic forecast states are [x, y, absolute time, vx, vy].
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

// The route leaves the beam and returns near its start one lap later: the field almost
// closes this lap. `seam` is the closure error in px, `seamSpeed` the velocity error.
function returnRoute(seam = 6, seamSpeed = 0, period = 3) {
	return makeRoute([
		[0, 0, 0, 100, 0],
		[70, 45, period / 4, 60, 80],
		[140, 0, period / 2, -100, 0],
		[70, -45, 3 * period / 4, 60, -80],
		[seam, 0, period, 100 + seamSpeed, 0]
	]);
}

function setCircleLoop(sim, radius, speed, count) {
	const loop = sim.loop;
	for (let k = 0; k < count; k++) {
		const a = TAU * k / count;
		loop.x[k] = radius * Math.cos(a); loop.y[k] = radius * Math.sin(a);
		loop.vx[k] = -speed * Math.sin(a); loop.vy[k] = speed * Math.cos(a);
	}
	loop.count = count;
	loop.start = 0;
	loop.period = TAU * radius / speed;
	loop.step = loop.period / (count - 1);
}

test('loop detection finds the beam\'s own almost-closed lap', () => {
	const sim = new Reactor();
	sim.particle.x = 0; sim.particle.y = 0;
	const pair = sim.findLoopPair(returnRoute());
	assert.equal(pair.found, true);
	assert.equal(pair.i, 0);
	assert.equal(pair.j, 4);
});

test('loop detection rejects an opposing recurrence at the same place', () => {
	const sim = new Reactor();
	sim.particle.x = 0; sim.particle.y = 0;
	const route = returnRoute();
	route.vx[4] = -100;
	assert.equal(sim.findLoopPair(route).found, false);
});

test('loop detection ignores recurrences shorter than the minimum lap period', () => {
	const sim = new Reactor();
	sim.particle.x = 0; sim.particle.y = 0;
	assert.equal(sim.findLoopPair(returnRoute(6, 0, 1)).found, false);
	sim.guidePeriod = 0.5;
	assert.equal(sim.findLoopPair(returnRoute(6, 0, 1)).found, true);
});

test('the committed loop is stitched into one closed rail', () => {
	const sim = new Reactor();
	sim.commitLoop(returnRoute(9, 12), { i: 0, j: 4 });
	const loop = sim.loop;
	assert.equal(loop.count, 5);
	near(loop.x[loop.count - 1], loop.x[0]);
	near(loop.y[loop.count - 1], loop.y[0]);
	near(loop.vx[loop.count - 1], loop.vx[0]);
	near(loop.vy[loop.count - 1], loop.vy[0]);
	const intervals = loop.count - 1;
	const a = sim.loopStateAt(0, { x: 0, y: 0, vx: 0, vy: 0 });
	const b = sim.loopStateAt(intervals - 1e-9, { x: 0, y: 0, vx: 0, vy: 0 });
	assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.01, 'the rail wraps around without a seam');
});

test('guidance is idle without a committed loop and pulls a nearby aligned beam onto the rail', () => {
	const sim = new Reactor();
	sim.loop.count = 0;
	near(Math.hypot(...Object.values(sim.guidanceVector({ x: 0, y: 0, vx: 100, vy: 0 }, 1, {}))), 0);
	setCircleLoop(sim, 100, 100, 64);
	const debug = {};
	const force = sim.guidanceVector({ x: 120, y: 0, vx: 0, vy: 100 }, 0.9, debug);
	assert.ok(force.x < -1, 'the pull points inward, toward the rail');
	near(force.y, 0, 1);
	assert.equal(debug.engaged, true);
	near(debug.distance, 20, 0.5);
});

test('the pull is zero outside the distance and direction tolerances', () => {
	const sim = new Reactor();
	setCircleLoop(sim, 100, 100, 64);
	const magnitude = p => Math.hypot(...Object.values(sim.guidanceVector(p, 0.9, {})));
	near(magnitude({ x: 141, y: 0, vx: 0, vy: 100 }), 0);
	near(magnitude({ x: 120, y: 0, vx: 0, vy: -100 }), 0);
	sim.guideDistance = 15;
	near(magnitude({ x: 120, y: 0, vx: 0, vy: 100 }), 0);
});

test('distance and heading fades reduce authority smoothly toward the tolerances', () => {
	const sim = new Reactor();
	sim.guideVelocity = 0;
	setCircleLoop(sim, 100, 100, 64);
	const magnitude = p => Math.hypot(...Object.values(sim.guidanceVector(p, 0.9, {})));
	// Past the full-authority plateau the fade must beat the growing position error:
	// 39 px from the rail is weaker than 30 px, and 40 px is exactly zero.
	const plateau = magnitude({ x: 130, y: 0, vx: 0, vy: 100 });
	const fading = magnitude({ x: 139, y: 0, vx: 0, vy: 100 });
	assert.ok(plateau > fading && fading > 0, 'force fades with distance');
	const aligned = magnitude({ x: 120, y: 0, vx: 0, vy: 100 });
	const skewed = magnitude({ x: 120, y: 0, vx: 44, vy: 90 });
	assert.ok(skewed < aligned, 'force fades with heading error');
});

test('the default scenario commits a loop and the beam rides it', () => {
	const sim = new Reactor();
	assert.ok(sim.loop.count > 2, 'the initial prediction already almost closes a lap');
	let engaged = 0, held = 0, samples = 0;
	for (let i = 0; i < 120 * 30; i++) {
		sim.step();
		if (sim.time < 8 || i % 4) continue;
		samples++;
		if (sim.liveDebug.engaged) engaged++;
		if (sim.loop.count > 0) held++;
		assert.ok(Number.isFinite(sim.particle.x) && Number.isFinite(sim.particle.vy));
	}
	assert.ok(held / samples > 0.9, 'the committed loop is held');
	assert.ok(engaged / samples > 0.8, 'the beam rides the rail');
});

test('debug aim point, movement vectors, and live force describe one current state', () => {
	const sim = new Reactor();
	for (let i = 0; i < 120 * 12; i++) sim.step();
	const d = sim.liveDebug;
	assert.equal(d.valid, sim.loop.count > 1);
	if (!d.valid) return;
	assert.ok(Number.isFinite(d.tx) && Number.isFinite(d.tvx));
	assert.ok(d.period > 0);
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

test('forecast refresh keeps the display forecast rooted at the live state', () => {
	const sim = new Reactor();
	for (let i = 0; i < 120 * 8; i++) {
		sim.step();
		assert.ok(Math.abs(sim.path.t[0] - sim.time) < 1, 'refresh never displays a stale start');
	}
});

test('long runs remain finite and bounded across guide settings', () => {
	for (const strength of [0, 1.5]) {
		for (const distance of [0, 40, 120]) {
			const sim = new Reactor();
			sim.guideStrength = strength;
			sim.guideDistance = distance;
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

test('skipDisplayForecast leaves live dynamics bit-identical', () => {
	const a = new Reactor(), b = new Reactor();
	b.skipDisplayForecast = true;
	b.predict(true);
	for (let i = 0; i < 120 * 20; i++) { a.step(); b.step(); }
	assert.deepEqual(a.particle, b.particle);
	assert.equal(a.loop.count, b.loop.count);
	assert.equal(a.loop.period, b.loop.period);
	assert.equal(a.stableTime, b.stableTime);
	for (let k = 0; k < a.targets.length; k++) assert.equal(a.targets[k].actual, b.targets[k].actual);
	assert.equal(a.cooling, b.cooling);
});
