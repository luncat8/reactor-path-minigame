'use strict';
// Parameter sweep for the loop-lock guide. Not loaded by the page.
// Measures whether the guide closes the lap gap: live phase recurrence against states
// one or more laps old, loop-held and engaged fractions, and lap seam drift.
const { Reactor } = require('../js/reactor.js');

function run(settings, seconds = 60) {
	const sim = new Reactor();
	Object.assign(sim, settings);
	sim.predict();
	const history = [];
	const recurrence = [];
	let engaged = 0, held = 0, samples = 0, forceSum = 0, locked = 0;
	for (let step = 0; step < 120 * seconds; step++) {
		sim.step();
		if (step % 3) continue;
		const p = sim.particle;
		let best = Infinity;
		for (let i = 0; i < history.length; i++) {
			const q = history[i];
			const age = sim.time - q.time;
			if (age < 3 || age > 15) continue;
			const pSpeed = Math.hypot(p.vx, p.vy), qSpeed = Math.hypot(q.vx, q.vy);
			if (pSpeed < 1e-8 || qSpeed < 1e-8 || p.vx * q.vx + p.vy * q.vy <= 0) continue;
			best = Math.min(best, Math.hypot(Math.hypot(p.x - q.x, p.y - q.y), Math.hypot(p.vx - q.vx, p.vy - q.vy) * 0.75));
		}
		if (sim.time > 10 && Number.isFinite(best)) {
			recurrence.push(best);
			if (best < 50) locked++;
		}
		history.push({ time: sim.time, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
		while (history.length && sim.time - history[0].time > 15) history.shift();
		if (sim.time > 10) {
			samples++;
			if (sim.liveDebug.engaged) engaged++;
			if (sim.loop.count > 0) held++;
			forceSum += Math.hypot(sim.liveForce.x, sim.liveForce.y);
		}
	}
	recurrence.sort((a, b) => a - b);
	const pct = f => recurrence.length ? recurrence[Math.min(recurrence.length - 1, Math.floor(recurrence.length * f))] : Infinity;
	return {
		median: pct(0.5), p90: pct(0.9),
		locked: recurrence.length ? locked / recurrence.length : 0,
		engaged: samples ? engaged / samples : 0,
		held: samples ? held / samples : 0,
		force: samples ? forceSum / samples : 0
	};
}

const header = 'strength dist dir  vel | recurrence median/p90  locked%  engaged%  held%  |F|';
console.log(header);
const strengths = process.argv[2] ? process.argv.slice(2).map(Number) : [0.4, 0.65, 0.9, 1.2, 1.5];
for (const strength of strengths) {
	for (const dist of [40, 60, 80, 100]) {
		const r = run({ guideStrength: strength, guideDistance: dist, guideDirection: 30 });
		console.log(
			`  ${strength.toFixed(2)}  ${String(dist).padStart(3)}  30  0.35 |  ${r.median.toFixed(0).padStart(5)} / ${r.p90.toFixed(0).padStart(5)}   ${(100 * r.locked).toFixed(0).padStart(4)}%   ${(100 * r.engaged).toFixed(0).padStart(4)}%  ${(100 * r.held).toFixed(0).padStart(3)}%  ${r.force.toFixed(2)}`
		);
	}
}
