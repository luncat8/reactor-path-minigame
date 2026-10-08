'use strict';
// Robustness validation of the tuned loop-lock guide. Not loaded by the page.
const { Reactor } = require('../js/reactor.js');

function stats(samples) {
	const sorted = samples.map(s => s.v).sort((a, b) => a - b);
	const pct = f => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] : Infinity;
	let locked = 0;
	for (const v of sorted) if (v < 50) locked++;
	return { median: pct(0.5), p90: pct(0.9), locked: sorted.length ? locked / sorted.length : 0, count: sorted.length };
}

// `windows` slices the recurrence timeline into labelled [from, to) segments, so a
// perturbation run reports the transient and the recovery separately instead of one
// aggregate median that mixes the locked, disturbed, and re-locked phases.
function run(seconds, { mutate, setup, windows } = {}) {
	const sim = new Reactor();
	if (setup) setup(sim);
	sim.predict();
	const recurrence = [];
	const history = [];
	let engaged = 0, samples = 0, maxX = 0, maxY = 0, maxV = 0, finite = true;
	for (let step = 0; step < 120 * seconds; step++) {
		if (mutate) mutate(sim, sim.time);
		sim.step();
		const p = sim.particle;
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.vx) || !Number.isFinite(p.vy)) { finite = false; break; }
		maxX = Math.max(maxX, Math.abs(p.x)); maxY = Math.max(maxY, Math.abs(p.y)); maxV = Math.max(maxV, Math.hypot(p.vx, p.vy));
		if (step % 3) continue;
		let best = Infinity;
		for (let i = 0; i < history.length; i++) {
			const q = history[i];
			const age = sim.time - q.time;
			if (age < 3 || age > 15) continue;
			if (p.vx * q.vx + p.vy * q.vy <= 0) continue;
			best = Math.min(best, Math.hypot(Math.hypot(p.x - q.x, p.y - q.y), Math.hypot(p.vx - q.vx, p.vy - q.vy) * 0.75));
		}
		if (sim.time > 10 && Number.isFinite(best)) recurrence.push({ t: sim.time, v: best });
		history.push({ time: sim.time, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
		while (history.length && sim.time - history[0].time > 15) history.shift();
		if (sim.time > 10) { samples++; if (sim.liveDebug.engaged) engaged++; }
	}
	const overall = stats(recurrence);
	const result = { ...overall, engaged: samples ? engaged / samples : 0, maxX, maxY, maxV, finite };
	if (windows) {
		result.windows = windows.map(w => ({
			label: w.label,
			...stats(recurrence.filter(r => r.t >= w.from && r.t < w.to))
		}));
	}
	return result;
}

function printStats(label, r) {
	console.log(`  ${label} recurrence median ${r.median.toFixed(1)} p90 ${r.p90.toFixed(1)}  locked ${(100 * r.locked).toFixed(0)}%`);
}

console.log('== tuned defaults (strength 0.9, dist 40, dir 30) over 120 s ==');
const base = run(120);
printStats('', base);
console.log(`  engaged ${(100 * base.engaged).toFixed(0)}%  bounds |x|<${base.maxX.toFixed(0)} |y|<${base.maxY.toFixed(0)} v<${base.maxV.toFixed(0)}  finite=${base.finite}`);

console.log('== guidance disabled baseline (strength 0) ==');
const off = run(60, { setup: sim => { sim.guideStrength = 0; } });
printStats('', off);
console.log('  (higher = no lock, expected)');

console.log('== magnet perturbation at t=40: loop should re-acquire ==');
// The edit is applied exactly once (a flag, not a time window: the mutate hook runs
// before every 120 Hz step, so a window applies the same edit several times).
let edited = false;
const pert = run(80, {
	mutate: (sim, t) => {
		if (edited || t < 40) return;
		edited = true;
		sim.magnets[0].x += 60; sim.magnets[1].angle += 0.7; sim.predict(true);
	},
	windows: [
		{ label: 'locked pre-edit t10-40 ', from: 10, to: 40 },
		{ label: 'transient t40-55       ', from: 40, to: 55 },
		{ label: 'recovered t55-80       ', from: 55, to: 80 }
	]
});
printStats('overall', pert);
for (const w of pert.windows) printStats(w.label, w);
console.log(`  finite=${pert.finite}`);

console.log('== boundary probe: one much larger simultaneous edit ==');
// Two magnets moved at once, twice the documented distance and rotation. The perturbed
// field no longer offers a lap the pull can complete: expected to churn through rails
// without re-locking. This is the guide's design boundary, not a regression.
let largeEdit = false;
const large = run(100, {
	mutate: (sim, t) => {
		if (largeEdit || t < 40) return;
		largeEdit = true;
		sim.magnets[0].x += 120; sim.magnets[1].angle += 1.4; sim.predict(true);
	},
	windows: [
		{ label: 'locked pre-edit t10-40 ', from: 10, to: 40 },
		{ label: 'after edit t55-100     ', from: 55, to: 100 }
	]
});
for (const w of large.windows) printStats(w.label, w);
console.log(`  finite=${large.finite}`);

console.log('== determinism ==');
const a = new Reactor(), b = new Reactor();
a.predict(); b.predict();
for (let i = 0; i < 120 * 40; i++) { a.step(); b.step(); }
console.log(`  identical after 40 s: ${JSON.stringify(a.particle) === JSON.stringify(b.particle) && a.loop.count === b.loop.count}`);

console.log('== stability objective, default field (targets within ±30%, cooling < 1.5%) ==');
const simS = new Reactor();
simS.predict();
for (let i = 0; i < 120 * 60; i++) simS.step();
console.log(`  stableTime ${simS.stableTime.toFixed(1)} s (>=8 means objective reached)`);
for (const t of simS.targets) console.log(`  target ${t.name}: live deviation ${((t.actual / t.desired - 1) * 100).toFixed(0)}%`);
console.log(`  cooling ${(simS.cooling * 100).toFixed(2)}%`);
