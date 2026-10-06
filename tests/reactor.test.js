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


// A synthetic reference plan: points sampled at the forecast interval, straight or hand-shaped.
function makeRoute(points) {
	const count = points.length;
	const route = { count, x: new Float64Array(count), y: new Float64Array(count), t: new Float64Array(count), s: new Float64Array(count) };
	for (let i = 0; i < count; i++) { route.x[i] = points[i][0]; route.y[i] = points[i][1]; route.t[i] = i / 40; }
	for (let i = 1; i < count; i++) route.s[i] = route.s[i - 1] + Math.hypot(route.x[i] - route.x[i - 1], route.y[i] - route.y[i - 1]);
	return route;
}
const line = (spacing, count) => makeRoute(Array.from({ length: count }, (_, i) => [i * spacing, 0]));
const newGuide = () => ({ segment: -1, x: 0, y: 0, s: 0, speed: 0, distance: 0, wide: true });

test('the guide point is the true projection onto the reference, not the nearest sample', () => {
	const sim = new Reactor();
	sim.magnets.forEach(magnet => { magnet.strength = 0; });
	sim.reflectors.length = 0;
	const route = line(3.625, 41);           // 1 s of travel at 145 px/s
	const state = newGuide();
	const debug = {};
	sim.guidanceVector({ x: 20, y: 8, vx: 145, vy: 0 }, route, 1, debug, state);
	near(state.x, 20, 1e-9);                 // between samples 5 and 6, not on either node
	near(state.y, 0, 1e-9);
	near(state.distance, 8, 1e-9);
	// The aim point sits one look-ahead interval of arc length further along the route.
	near(debug.tx, 20 + 0.1 * 145, 1e-9);
	near(debug.ty, 0, 1e-9);
	near(debug.angle, 0, 1e-9);
});

test('guidance is exactly lateral: it can never thrust, brake or point backwards', () => {
	const sim = new Reactor();
	sim.magnets.forEach(magnet => { magnet.strength = 0; });
	sim.reflectors.length = 0;
	const route = line(3.625, 121);
	const speed = 145;
	let checked = 0, active = 0;
	for (let offset = -60; offset <= 60; offset += 7) {
		for (let degrees = -80; degrees <= 80; degrees += 9) {
			const angle = degrees * Math.PI / 180;
			const particle = { x: 30, y: offset, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
			const state = newGuide();
			const force = sim.guidanceVector(particle, route, 1, null, state);
			// Perpendicular by construction: no component along the velocity, so the force cannot
			// change the beam's speed and its angle to the velocity can never leave 0..90 degrees.
			const along = force.x * particle.vx + force.y * particle.vy;
			assert.ok(Math.abs(along) < 1e-9 * speed * Math.max(1, Math.hypot(force.x, force.y)),
				`force is not lateral: ${along}`);
			checked++;
			if (Math.hypot(force.x, force.y) > 0) active++;
		}
	}
	assert.ok(checked > 100);
	assert.ok(active > 80, 'most of the grid should actually steer');
});

test('the plan schedule cannot drag the nearest point off the beam', () => {
	const sim = new Reactor();
	// The route is geometrically under the beam, but its timestamps claim the plan is ten seconds old:
	// anything that seeds the projection on "the sample scheduled for now" projects the ring far away.
	const route = line(3.625, 41);
	for (let i = 0; i < route.count; i++) route.t[i] = -10 + i;
	const state = newGuide();
	const debug = {};
	const force = sim.guidanceVector({ x: 20, y: 0, vx: 145, vy: 0 }, route, 1, debug, state);
	near(state.x, 20, 1e-9);
	near(state.y, 0, 1e-9);
	near(debug.distance, 0, 1e-12);
	near(Math.hypot(force.x, force.y), 0, 1e-12);
});

test('the steering force points from the beam at the nearest route point', () => {
	const sim = new Reactor();
	const route = line(3.625, 121);
	const speed = 145;
	for (const offset of [4, 12, 30]) {
		const particle = { x: 30, y: offset, vx: speed, vy: 0 };
		const state = newGuide();
		const debug = {};
		const force = sim.guidanceVector(particle, route, 1, debug, state);
		const ringX = debug.nx - particle.x, ringY = debug.ny - particle.y;
		const ringLength = Math.hypot(ringX, ringY);
		near(ringLength, offset, 1e-9);                       // the ring is the true nearest point
		near(debug.tx - debug.nx, 0.1 * speed, 1e-9);         // the look-ahead dot sits one aim ahead
		// A parallel beam is pushed exactly along the line to the ring.
		const forceLength = Math.hypot(force.x, force.y);
		near(force.x / forceLength, ringX / ringLength, 1e-9);
		near(force.y / forceLength, ringY / ringLength, 1e-9);
		assert.ok(force.y < 0);
	}
});

test('an offset beam is pulled back to the route, an on-route beam needs no force', () => {
	const sim = new Reactor();
	sim.magnets.forEach(magnet => { magnet.strength = 0; });
	sim.reflectors.length = 0;
	const route = line(3.625, 121);
	const tracking = sim.guidanceVector({ x: 30, y: 0, vx: 145, vy: 0 }, route, 1, null, newGuide(), 4);
	near(tracking.x, 0, 1e-9); near(tracking.y, 0, 1e-9);
	const offset = sim.guidanceVector({ x: 30, y: 25, vx: 145, vy: 0 }, route, 1, null, newGuide(), 4);
	near(offset.x, 0, 1e-9);
	assert.ok(offset.y < 0, 'an offset beam is pulled back toward the route');
	// gain × lateral correction, faded by how far the beam sits inside the reach
	near(Math.abs(offset.y), 25 * 0.5 * 0.84375, 1e-9);
});

test('opposing and perpendicular passes of a self-crossing route cannot capture the beam', () => {
	const sim = new Reactor();
	// Outbound leg at y = 3, return leg at y = 0. A +x beam sits next to the return leg, which is
	// physically closer, but only the outbound leg continues its heading.
	const route = makeRoute([[0, 3], [10, 3], [20, 3], [20, 0], [10, 0], [0, 0], [-10, 0]]);
	const state = newGuide();
	const outbound = { x: 0, y: 1, vx: 100, vy: 0 };
	sim.guidanceVector(outbound, route, 1, null, state, 0);
	near(state.y, 3, 1e-9);
	assert.equal(state.segment, 0);
	const returning = { x: 0, y: 1, vx: -100, vy: 0 };
	const reverseState = newGuide();
	sim.guidanceVector(returning, route, 1, null, reverseState, 5);
	assert.ok(reverseState.y <= 1e-9, 'a −x beam locks onto the returning pass');

	// A beam flying straight at a +x route (perpendicular) receives nothing at all.
	const perpendicular = { x: 30, y: -40, vx: 0, vy: 145 };
	const perpendicularState = newGuide();
	const force = sim.guidanceVector(perpendicular, line(3.625, 121), 1, null, perpendicularState, 4);
	assert.equal(perpendicularState.segment, -1);
	near(Math.hypot(force.x, force.y), 0);
});

test('distance and heading falloffs gate guidance smoothly', () => {
	const sim = new Reactor();
	sim.magnets.forEach(magnet => { magnet.strength = 0; });
	sim.reflectors.length = 0;
	const route = line(3.625, 241);
	const magnitude = (offset, degrees) => {
		const angle = degrees * Math.PI / 180;
		const state = newGuide();
		const force = sim.guidanceVector({ x: 30, y: offset, vx: Math.cos(angle) * 145, vy: Math.sin(angle) * 145 }, route, 1, null, state, 8);
		return Math.hypot(force.x, force.y);
	};
	const near20 = magnitude(20, 0);
	assert.ok(near20 > 0);
	assert.ok(magnitude(90, 0) < near20, 'the pull shrinks toward the reach');
	near(magnitude(100, 0), 0);
	assert.ok(magnitude(20, 60) < near20, 'heading mismatch fades the pull');
	near(magnitude(20, 90), 0);
	sim.guideDirection = 45;
	near(magnitude(20, 45), 0);
});

test('the route is a committed plan held for the selected memory', () => {
	const commitInterval = planLag => {
		const sim = new Reactor();
		sim.planLag = planLag;
		for (let i = 0; i < 120 * 3; i++) sim.step();
		let commits = 0, first = sim.referenceTime, last = first;
		for (let i = 0; i < 120 * 9; i++) {
			sim.step();
			if (sim.referenceTime === last) continue;
			last = sim.referenceTime;
			commits++;
		}
		assert.ok(commits > 0, 'the route is refreshed');
		return { interval: (last - first) / commits, age: sim.referenceAge, sim };
	};
	const held = commitInterval(1.2);
	near(held.interval, 1.2, 0.01);                       // memory holds roughly two refreshes
	assert.ok(held.age <= 1.2 + 1e-9);
	const live = commitInterval(0);
	near(live.interval, 0.6, 0.01);                       // memory off: every refresh is adopted
	near(live.age, 0, 0.6);
});

test('a held route resists deviation, while memory off adopts it at the next refresh', () => {
	const deviationAt = planLag => {
		const sim = new Reactor();
		sim.planLag = planLag;
		for (let i = 0; i < 120 * 20; i++) sim.step();
		while (sim.referenceAge > 0.1) sim.step();       // start from a freshly committed route
		const speed = Math.hypot(sim.particle.vx, sim.particle.vy);
		sim.particle.x += -sim.particle.vy / speed * 15;
		sim.particle.y += sim.particle.vx / speed * 15;
		sim.liveGuide.segment = -1; sim.liveGuide.wide = true;
		const seen = [];
		for (let i = 0; i < 120 * 1.6; i++) {
			sim.step();
			if (i % 60 === 59) seen.push(Number(sim.liveDebug.distance.toFixed(2)));
		}
		return seen;
	};
	const held = deviationAt(1.2);
	const live = deviationAt(0);
	assert.ok(held[0] > 4, `the held route must still see the deviation: ${held}`);
	assert.ok(live[0] <= 0.5, `memory off adopts the beam at the next refresh: ${live}`);
});

test('a field change is resisted while the route is held and adopted once the memory expires', () => {
	const run = planLag => {
		const sim = new Reactor();
		sim.planLag = planLag;
		for (let i = 0; i < 120 * 25; i++) sim.step();
		while (sim.referenceAge > 0.1) sim.step();
		sim.magnets[0].polarity *= -1; sim.predict();
		let cross = 0, samples = 0, backwards = 0;
		for (let i = 0; i < 120 * 2; i++) {
			const vx = sim.particle.vx, vy = sim.particle.vy, speed = Math.hypot(vx, vy);
			sim.step();
			cross += sim.liveDebug.distance; samples++;
			// Pair the published force with the published velocity: it is computed from the position the
			// beam now stands at, so it must be exactly perpendicular to the current velocity.
			const px = sim.particle.vx, py = sim.particle.vy, now = Math.hypot(px, py);
			const force = Math.hypot(sim.liveForce.x, sim.liveForce.y);
			if (force < 1e-9 || now < 1e-9) continue;
			if ((sim.liveForce.x * px + sim.liveForce.y * py) / (force * now) < -1e-9) backwards++;
		}
		return { cross: cross / samples, backwards, sim };
	};
	const held = run(1.2);
	const live = run(0);
	assert.ok(held.cross > live.cross + 0.05, `held route should keep real error: ${held.cross} vs ${live.cross}`);
	assert.equal(held.backwards, 0);
	assert.equal(live.backwards, 0);
});

test('the anchor follows the route it is flying instead of jumping between passes', () => {
	const sim = new Reactor();
	let previous = -1, previousRoute = -1, largestAdvance = 0;
	for (let i = 0; i < 120 * 60; i++) {
		sim.step();
		const guide = sim.liveGuide;
		if (guide.segment < 0 || sim.liveDebug.nearest < 0) { previous = -1; continue; }
		// A commit re-seats the anchor on a different plan; continuity is measured inside one route.
		if (previous >= 0 && previousRoute === sim.referenceTime) largestAdvance = Math.max(largestAdvance, Math.abs(guide.s - previous));
		previous = guide.s; previousRoute = sim.referenceTime;
	}
	// One step at 145 px/s advances 1.2 px of arc; a crossing pass would move the anchor tens of pixels.
	assert.ok(largestAdvance < 12, `anchor jumped ${largestAdvance.toFixed(1)} px in one step`);
});

test('long runs remain finite and bounded across field settings', () => {
	for (const strength of [0, 1, 2]) {
		for (const planLag of [0, 1.2]) {
			const sim = new Reactor();
			sim.guideStrength = strength === 2 ? 1.5 : strength;
			sim.planLag = planLag;
			for (const m of sim.magnets) m.strength = strength;
			for (let i = 0; i < 120 * 60; i++) {
				sim.step();
				assert.ok(Number.isFinite(sim.particle.vx) && Number.isFinite(sim.particle.vy));
				assert.ok(Math.abs(sim.particle.x) < 500 && Math.abs(sim.particle.y) < 400);
			}
		}
	}
});

test('targets and cooling zones do not alter the particle dynamics', () => {
	const a = new Reactor(), b = new Reactor();
	b.targets.length = 0; b.zones.length = 0;
	for (let i = 0; i < 300; i++) { a.step(); b.step(); }
	assert.deepEqual(a.particle, b.particle);
});
