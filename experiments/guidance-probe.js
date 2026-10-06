'use strict';
// Deterministic probe for future-return selection and phase recurrence. Not loaded by the page.
const { Reactor } = require('../js/reactor.js');
const degrees = radians => radians * 180 / Math.PI;

function route(states) {
	const count = states.length;
	const value = {
		count,
		x: new Float64Array(count), y: new Float64Array(count),
		vx: new Float64Array(count), vy: new Float64Array(count), t: new Float64Array(count)
	};
	for (let i = 0; i < count; i++) {
		value.x[i] = states[i][0]; value.y[i] = states[i][1]; value.t[i] = states[i][2];
		value.vx[i] = states[i][3]; value.vy[i] = states[i][4];
	}
	return value;
}

function selectionProbe() {
	const sim = new Reactor();
	const plan = route([
		[-20, 1, 3, -100, 0], [20, 1, 4, -100, 0],
		[-20, 9, 5, 100, 0], [20, 9, 6, 100, 0]
	]);
	const particle = { x: 0, y: 0, vx: 100, vy: 0 };
	const debug = {};
	const force = sim.guidanceVector(particle, plan, 0, 1, debug);
	return { debug, force };
}

function percentile(sorted, fraction) {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// Compare each live state with states from 3–15 seconds ago. The metric combines pixel distance
// and velocity error using the same 0.75-second conversion as target selection; lower is a more
// repeatable loop state.
function recurrenceProbe(strength, seconds = 40) {
	const sim = new Reactor();
	sim.guideStrength = strength;
	sim.predict();
	const history = [], recurrence = [];
	let forceSum = 0, distanceSum = 0, speedErrorSum = 0, targetSamples = 0, samples = 0;
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
			const positionError = Math.hypot(p.x - q.x, p.y - q.y);
			const velocityError = Math.hypot(p.vx - q.vx, p.vy - q.vy);
			best = Math.min(best, Math.hypot(positionError, velocityError * 0.75));
		}
		if (sim.time > 10 && Number.isFinite(best)) recurrence.push(best);
		history.push({ time: sim.time, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
		while (history.length && sim.time - history[0].time > 15) history.shift();
		forceSum += Math.hypot(sim.liveForce.x, sim.liveForce.y);
		samples++;
		if (sim.liveDebug.target < 0) continue;
		targetSamples++;
		distanceSum += sim.liveDebug.distance;
		speedErrorSum += sim.liveDebug.speedError;
	}
	recurrence.sort((a, b) => a - b);
	return {
		median: percentile(recurrence, 0.5), p90: percentile(recurrence, 0.9),
		force: forceSum / samples, targetRate: targetSamples / samples,
		distance: targetSamples ? distanceSum / targetSamples : 0,
		speedError: targetSamples ? speedErrorSum / targetSamples : 0
	};
}

const selection = selectionProbe();
console.log('== synthetic crossing: wrong-way pass is 1 px away, compatible pass is 9 px away ==');
console.log(`  selected target (${selection.debug.tx.toFixed(1)}, ${selection.debug.ty.toFixed(1)}) at +${selection.debug.lead.toFixed(1)} s`);
console.log(`  target movement (${selection.debug.tvx.toFixed(1)}, ${selection.debug.tvy.toFixed(1)}) px/s`);
console.log(`  current movement (100.0, 0.0) px/s`);
console.log(`  matching force (${selection.force.x.toFixed(2)}, ${selection.force.y.toFixed(2)}) — target heading error ${degrees(selection.debug.angle).toFixed(1)}°`);
console.log('== live phase recurrence (position plus 0.75 s of velocity error; lower is better) ==');
for (const strength of [0, 0.65]) {
	const result = recurrenceProbe(strength);
	console.log(`  strength ${strength.toFixed(2)}  recurrence median ${result.median.toFixed(1)} p90 ${result.p90.toFixed(1)}`);
	console.log(`    target ${(100 * result.targetRate).toFixed(1)}%  target distance ${result.distance.toFixed(1)} px  movement Δ ${result.speedError.toFixed(1)} px/s  |F| ${result.force.toFixed(2)}`);
}
