'use strict';
// Deterministic measurement of the trajectory guide: nearest-point tracking, force direction,
// deviation authority, route memory and forecast self-consistency. Not loaded by the page.
const { Reactor } = require('../js/reactor.js');

// A synthetic plan: points sampled at the forecast interval along a straight line.
function straightRoute(count, spacing) {
	const route = { count, x: new Float64Array(count), y: new Float64Array(count), t: new Float64Array(count), s: new Float64Array(count) };
	for (let i = 0; i < count; i++) { route.x[i] = i * spacing; route.t[i] = i / 40; route.s[i] = i * spacing; }
	return route;
}
const newGuide = () => ({ segment: -1, x: 0, y: 0, s: 0, speed: 0, distance: 0, wide: true });

// Telemetry of the live guide over a run, including a paired view around a field edit.
function telemetry(seconds, strength, planLag, editAt) {
	const sim = new Reactor();
	sim.guideStrength = strength;
	sim.planLag = planLag;
	if (editAt) { sim.predict(); while (sim.referenceAge > 0.1) sim.step(); }
	const editStep = editAt ? Math.round(120 * editAt) : -1;
	const stats = { samples: 0, backwards: 0, maxAngle: 0, cross: 0, crossMax: 0, force: 0, forceMax: 0, field: 0,
		preCross: 0, preForce: 0, preN: 0, postCross: 0, postForce: 0, postN: 0, idle: 0 };
	for (let i = 0; i < 120 * seconds; i++) {
		if (i === editStep) { sim.magnets[0].polarity *= -1; sim.predict(); }
		const vx = sim.particle.vx, vy = sim.particle.vy, speed = Math.hypot(vx, vy);
		sim.step();
		const p = sim.particle, d = sim.liveDebug, force = Math.hypot(sim.liveForce.x, sim.liveForce.y);
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
		if (force < 1e-6 || speed < 1e-6) { stats.idle++; continue; }
		const cosine = (sim.liveForce.x * vx + sim.liveForce.y * vy) / (force * speed);
		if (cosine < -1e-6) stats.backwards++;
		stats.maxAngle = Math.max(stats.maxAngle, Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI);
		if (d.nearest < 0) continue;
		stats.cross += d.distance; stats.crossMax = Math.max(stats.crossMax, d.distance);
		if (editStep < 0) continue;
		const before = i >= editStep - 240 && i < editStep;
		if (before) { stats.preCross += d.distance; stats.preForce += force; stats.preN++; }
		if (i >= editStep) { stats.postCross += d.distance; stats.postForce += force; stats.postN++; }
	}
	stats.cross /= stats.samples; stats.force /= stats.samples; stats.field /= stats.samples;
	stats.preCross /= stats.preN || 1; stats.preForce /= stats.preN || 1;
	stats.postCross /= stats.postN || 1; stats.postForce /= stats.postN || 1;
	return stats;
}

// Live telemetry with a forced lateral deviation, used to show how far a held route keeps the
// beam off it compared with a route that is adopted at every refresh.
function deviationHold(planLag) {
	const sim = new Reactor();
	sim.planLag = planLag;
	for (let i = 0; i < 120 * 20; i++) sim.step();
	while (sim.referenceAge > 0.1) sim.step();
	const speed = Math.hypot(sim.particle.vx, sim.particle.vy);
	sim.particle.x += -sim.particle.vy / speed * 15;
	sim.particle.y += sim.particle.vx / speed * 15;
	sim.liveGuide.segment = -1; sim.liveGuide.wide = true;
	const trace = [];
	for (let i = 0; i < 120 * 1.5; i++) {
		sim.step();
		if (i % 30 === 29) trace.push(Number(sim.liveDebug.distance.toFixed(1)));
	}
	return trace;
}

// Straight-route geometry: where the guide actually places the projection and the aim point.
function geometry() {
	const sim = new Reactor();
	const route = straightRoute(121, 3.625);       // 145 px/s at the forecast interval
	const state = newGuide();
	const debug = {};
	sim.guidanceVector({ x: 20, y: 8, vx: 145, vy: 0 }, route, 1, debug, state, 0);
	return { projection: [state.x, state.y], distance: state.distance, aim: [debug.tx, debug.ty], angle: debug.angle };
}

const geometryResult = geometry();
console.log('== guide geometry (straight route, beam 8 px off, sampled every 3.625 px) ==');
console.log(`  projection (${geometryResult.projection.map(v => v.toFixed(2)).join(', ')})  off-route ${geometryResult.distance.toFixed(2)} px`);
console.log(`  aim (${geometryResult.aim.map(v => v.toFixed(2)).join(', ')}) — exactly 100 ms of arc ahead of the projection`);
console.log('== live telemetry over 60 s ==');
for (const planLag of [0, 1.8, 3]) {
	const s = telemetry(60, 0.65, planLag);
	console.log(`  memory ${planLag.toFixed(1)}s  off-route avg ${s.cross.toFixed(2)} max ${s.crossMax.toFixed(1)}px  |F| avg ${s.force.toFixed(2)} max ${s.forceMax.toFixed(1)} (${(100 * s.force / s.field).toFixed(1)}% of field)  backwards ${s.backwards}  max angle ${s.maxAngle.toFixed(2)}  idle ticks ${s.idle}`);
}
console.log('== paired 4 s before / after a magnet polarity flip ==');
for (const planLag of [0, 1.8, 3]) {
	const s = telemetry(30, 0.65, planLag, 25);
	console.log(`  memory ${planLag.toFixed(1)}s  off-route ${s.preCross.toFixed(2)} -> ${s.postCross.toFixed(2)} px  |F| ${s.preForce.toFixed(3)} -> ${s.postForce.toFixed(3)}  backwards ${s.backwards}  max angle ${s.maxAngle.toFixed(2)}`);
}
console.log('== a 15 px deviation while the route is held (off-route px every 0.25 s) ==');
for (const planLag of [0, 1.8, 3]) console.log(`  memory ${planLag.toFixed(1)}s: ${deviationHold(planLag).join(' ')}`);
