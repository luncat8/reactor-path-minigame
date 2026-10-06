'use strict';
// Deterministic measurement of the trajectory guide: nearest-point placement, force direction
// against the ring it draws, lateral-only steering, deviation authority and route memory.
// Not loaded by the page.
const { Reactor } = require('../js/reactor.js');
const degrees = radians => radians * 180 / Math.PI;

// A synthetic plan: points sampled at the forecast interval along a straight line.
function straightRoute(count, spacing) {
	const route = { count, x: new Float64Array(count), y: new Float64Array(count), t: new Float64Array(count), s: new Float64Array(count) };
	for (let i = 0; i < count; i++) { route.x[i] = i * spacing; route.t[i] = i / 40; route.s[i] = i * spacing; }
	return route;
}
const newGuide = () => ({ segment: -1, x: 0, y: 0, s: 0, speed: 0, distance: 0, tangentX: 1, tangentY: 0, wide: true });

// Straight-route geometry: where the guide places the ring and the look-ahead dot, and whether the
// force it applies points at the ring.
function geometry() {
	const sim = new Reactor();
	const route = straightRoute(121, 3.625);            // 145 px/s at the forecast interval
	const state = newGuide();
	const debug = {};
	const particle = { x: 20, y: 8, vx: 145, vy: 0 };
	const force = sim.guidanceVector(particle, route, 1, debug, state);
	const ringX = debug.nx - particle.x, ringY = debug.ny - particle.y;
	const forceLength = Math.hypot(force.x, force.y);
	const ringLength = Math.hypot(ringX, ringY);
	return {
		projection: [state.x, state.y], distance: debug.distance,
		lookahead: [debug.tx, debug.ty], lookaheadArc: debug.tx - debug.nx,
		forceAngleToRing: degrees(Math.acos(Math.max(-1, Math.min(1, (force.x * ringX + force.y * ringY) / (forceLength * ringLength))))),
		forceAngleToVelocity: degrees(Math.acos(Math.max(-1, Math.min(1, (force.x * particle.vx + force.y * particle.vy) / (forceLength * Math.hypot(particle.vx, particle.vy))))))
	};
}

// Live telemetry over a run. `editAt` also flips a magnet polarity, and every `editEvery` seconds a
// magnet is dragged, which is what a player does: the held route then really is behind the beam.
function telemetry(seconds, planLag, editEvery) {
	const sim = new Reactor();
	sim.planLag = planLag;
	const stats = { samples: 0, idle: 0, drawn: 0, ringOff: 0, ringGap: 0, ringGapMax: 0, cross: 0, crossMax: 0,
		force: 0, forceMax: 0, field: 0, lateral: 0, angleSum: 0, angleMax: 0, away: 0, anchors: 0, anchorJump: 0 };
	let previousAnchor = -1, previousRoute = -1, nextEdit = editEvery;
	for (let i = 0; i < 120 * seconds; i++) {
		if (editEvery && sim.time >= nextEdit) {
			nextEdit += editEvery;
			sim.magnets[i % 4].angle += (i % 2 ? 1 : -1) * 0.4;
			sim.magnets[(i + 1) % 4].x += (i % 2 ? 1 : -1) * 25;
			sim.predict();
		}
		sim.step();
		const p = sim.particle, d = sim.liveDebug, v = Math.hypot(p.vx, p.vy);
		const force = Math.hypot(sim.liveForce.x, sim.liveForce.y);
		stats.samples++;
		let fx = -0.39 * p.x, fy = -0.64 * p.y;
		for (const m of sim.magnets) {
			const dx = m.x - p.x, dy = m.y - p.y, distance = Math.hypot(dx, dy) || 1, ux = dx / distance, uy = dy / distance;
			const mx = Math.cos(m.angle), my = Math.sin(m.angle), alignment = -ux * mx - uy * my;
			const f = m.strength * m.polarity * 2800000 / (distance * distance + 18000);
			fx += f * (ux * alignment + mx * 0.25); fy += f * (uy * alignment + my * 0.25);
		}
		stats.field += Math.hypot(fx, fy);
		stats.force += force; stats.forceMax = Math.max(stats.forceMax, force);
		if (force < 1e-9) { stats.idle++; } else {
			// The published force is computed from the position the beam now stands at, so it must be
			// exactly perpendicular to the current velocity: never thrust, never brake, never reversed.
			stats.lateral = Math.max(stats.lateral, Math.abs((sim.liveForce.x * p.vx + sim.liveForce.y * p.vy) / (force * v)));
		}
		if (d.nearest < 0) continue;
		stats.cross += d.distance; stats.crossMax = Math.max(stats.crossMax, d.distance);
		const ringGap = Math.hypot(d.nx - p.x, d.ny - p.y);
		stats.ringGap += ringGap; stats.ringGapMax = Math.max(stats.ringGapMax, ringGap);
		// Anchor continuity is only meaningful inside one committed route: a commit re-seats the
		// anchor onto a different plan, where a different arc length is expected.
		if (sim.liveGuide.segment >= 0 && !sim.liveGuide.wide) {
			if (previousRoute === sim.referenceTime && previousAnchor >= 0) {
				stats.anchorJump = Math.max(stats.anchorJump, Math.abs(sim.liveGuide.s - previousAnchor));
			}
			previousAnchor = sim.liveGuide.s; previousRoute = sim.referenceTime; stats.anchors++;
		}
		if (force < 0.25 || ringGap < 1) continue;
		stats.drawn++; stats.ringOff++;
		const angle = degrees(Math.acos(Math.max(-1, Math.min(1,
			(sim.liveForce.x * (d.nx - p.x) + sim.liveForce.y * (d.ny - p.y)) / (force * ringGap)))));
		stats.angleSum += angle; stats.angleMax = Math.max(stats.angleMax, angle);
		if (angle > 90) stats.away++;
	}
	stats.cross /= stats.samples; stats.force /= stats.samples; stats.field /= stats.samples;
	stats.ringGap /= stats.samples;
	stats.meanAngle = stats.ringOff ? stats.angleSum / stats.ringOff : 0;
	return stats;
}

// A live beam pushed 15 px sideways off its route: does the ring separate, and does the force
// point at it while the deviation closes?
function deviationHold(planLag) {
	const sim = new Reactor();
	sim.planLag = planLag;
	for (let i = 0; i < 120 * 20; i++) sim.step();
	while (sim.referenceAge > 0.1) sim.step();
	const speed = Math.hypot(sim.particle.vx, sim.particle.vy);
	sim.particle.x += -sim.particle.vy / speed * 15;
	sim.particle.y += sim.particle.vx / speed * 15;
	sim.liveGuide.wide = true;
	const trace = [];
	for (let i = 0; i < 120 * 1.5; i++) {
		sim.step();
		if (i % 30 !== 29) continue;
		const d = sim.liveDebug, f = Math.hypot(sim.liveForce.x, sim.liveForce.y);
		const ringGap = Math.hypot(d.nx - sim.particle.x, d.ny - sim.particle.y);
		const angle = f < 1e-9 || ringGap < 1 ? NaN : degrees(Math.acos(Math.max(-1, Math.min(1,
			(sim.liveForce.x * (d.nx - sim.particle.x) + sim.liveForce.y * (d.ny - sim.particle.y)) / (f * ringGap)))));
		trace.push(Number(d.distance.toFixed(1)) + 'px' + (isNaN(angle) ? '' : '/' + Math.round(angle) + '°'));
	}
	return trace;
}

// Paired view around a magnet polarity flip: off-route distance and force before and after.
function editResponse(planLag) {
	const sim = new Reactor();
	sim.planLag = planLag;
	for (let i = 0; i < 120 * 25; i++) sim.step();
	while (sim.referenceAge > 0.1) sim.step();
	sim.magnets[0].polarity *= -1; sim.predict();
	let cross = 0, force = 0, samples = 0;
	for (let i = 0; i < 120 * 2; i++) {
		sim.step();
		cross += sim.liveDebug.distance; force += Math.hypot(sim.liveForce.x, sim.liveForce.y); samples++;
	}
	return { cross: cross / samples, force: force / samples };
}

const geometryResult = geometry();
console.log('== guide geometry (straight route, beam 8 px off, sampled every 3.625 px) ==');
console.log(`  ring (${geometryResult.projection.map(v => v.toFixed(2)).join(', ')})  off-route ${geometryResult.distance.toFixed(2)} px`);
console.log(`  look-ahead dot (${geometryResult.lookahead.map(v => v.toFixed(2)).join(', ')}) — exactly 100 ms of arc ahead of the ring`);
console.log(`  force angle to the ring ${geometryResult.forceAngleToRing.toFixed(2)}° (0 = the arrow points straight at the green ring)`);
console.log(`  force angle to the velocity ${geometryResult.forceAngleToVelocity.toFixed(2)}° (90 = pure steering)`);
console.log('== 120 s of play: a magnet is dragged every 5 s ==');
for (const planLag of [0, 1.8, 3]) {
	const s = telemetry(120, planLag, 5);
	console.log(`  memory ${planLag.toFixed(1)}s  ring-on-beam gap avg ${s.ringGap.toFixed(2)} max ${s.ringGapMax.toFixed(1)}px  off-route avg ${s.cross.toFixed(2)} max ${s.crossMax.toFixed(1)}px`);
	console.log(`    |F| avg ${s.force.toFixed(3)} max ${s.forceMax.toFixed(1)} (${(100 * s.force / s.field).toFixed(2)}% of field)  idle ${(100 * s.idle / s.samples).toFixed(1)}%  max |cos(F,v)| ${s.lateral.toExponential(1)}`);
	console.log(`    drawn arrows ${s.drawn}  force-to-ring angle mean ${s.meanAngle.toFixed(1)}° max ${s.angleMax.toFixed(1)}°  pointing away ${s.away}  max anchor step ${s.anchorJump.toFixed(2)}px`);
}
console.log('== a 15 px deviation while the route is held (off-route px / force-to-ring degrees every 0.25 s) ==');
for (const planLag of [0, 1.8, 3]) console.log(`  memory ${planLag.toFixed(1)}s: ${deviationHold(planLag).join('  ')}`);
console.log('== 2 s after a magnet polarity flip ==');
for (const planLag of [0, 1.8, 3]) {
	const r = editResponse(planLag);
	console.log(`  memory ${planLag.toFixed(1)}s  off-route ${r.cross.toFixed(2)} px  |F| ${r.force.toFixed(3)}`);
}
