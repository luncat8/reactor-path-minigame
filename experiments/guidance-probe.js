'use strict';
// Deterministic probe for loop-lock guidance and phase recurrence. Not loaded by the page.
const { Reactor } = require('../js/reactor.js');

function percentile(sorted, fraction) {
	return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : Infinity;
}

// Compare each live state with states 3–15 seconds ago. The metric combines pixel distance
// and velocity error using a 0.75-second conversion; lower is a more repeatable loop state.
function recurrenceProbe(strength, seconds = 40) {
	const sim = new Reactor();
	sim.guideStrength = strength;
	sim.predict();
	const history = [], recurrence = [];
	let forceSum = 0, engaged = 0, held = 0, locked = 0, samples = 0;
	for (let step = 0; step < 120 * seconds; step++) {
		sim.step();
		if (step % 3) continue;
		const p = sim.particle;
		let best = Infinity;
		for (let i = 0; i < history.length; i++) {
			const q = history[i];
			const age = sim.time - q.time;
			if (age < 3 || age > 15) continue;
			if (p.vx * q.vx + p.vy * q.vy <= 0) continue;
			best = Math.min(best, Math.hypot(Math.hypot(p.x - q.x, p.y - q.y), Math.hypot(p.vx - q.vx, p.vy - q.vy) * 0.75));
		}
		if (sim.time > 10 && Number.isFinite(best)) {
			recurrence.push(best);
			if (best < 50) locked++;
		}
		history.push({ time: sim.time, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
		while (history.length && sim.time - history[0].time > 15) history.shift();
		forceSum += Math.hypot(sim.liveForce.x, sim.liveForce.y);
		samples++;
		if (sim.liveDebug.engaged) engaged++;
		if (sim.loop.count > 0) held++;
	}
	recurrence.sort((a, b) => a - b);
	return {
		median: percentile(recurrence, 0.5), p90: percentile(recurrence, 0.9),
		locked: recurrence.length ? locked / recurrence.length : 0,
		engaged: engaged / samples, held: held / samples, force: forceSum / samples
	};
}

const sim = new Reactor();
console.log('== loop detection on the default prediction ==');
console.log(`  committed lap: ${sim.loop.count ? sim.loop.period.toFixed(2) + ' s, ' + sim.loop.count + ' samples' : 'none'}`);
console.log('== live phase recurrence (position plus 0.75 s of velocity error; lower is better) ==');
for (const strength of [0, 0.9]) {
	const result = recurrenceProbe(strength);
	console.log(`  strength ${strength.toFixed(2)}  recurrence median ${result.median.toFixed(1)} p90 ${result.p90.toFixed(1)}  locked ${(100 * result.locked).toFixed(0)}%`);
	console.log(`    loop held ${(100 * result.held).toFixed(0)}%  riding ${(100 * result.engaged).toFixed(0)}%  |F| ${result.force.toFixed(2)}`);
}
