'use strict';
// Robustness validation of the tuned loop-lock guide. Not loaded by the page.
const { Reactor } = require('../js/reactor.js');

function medianP90(recurrence) {
	const s = [...recurrence].sort((a, b) => a - b);
	const pct = f => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : Infinity;
	return { median: pct(0.5), p90: pct(0.9) };
}

function run(seconds, mutate) {
	const sim = new Reactor();
	sim.predict();
	const history = [], recurrence = [];
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
		if (sim.time > 10 && Number.isFinite(best)) recurrence.push(best);
		history.push({ time: sim.time, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
		while (history.length && sim.time - history[0].time > 15) history.shift();
		if (sim.time > 10) { samples++; if (sim.liveDebug.engaged) engaged++; }
	}
	const m = medianP90(recurrence);
	let locked = 0; for (const r of recurrence) if (r < 50) locked++;
	return { median: m.median, p90: m.p90, locked: locked / (recurrence.length || 1), engaged: engaged / samples, maxX, maxY, maxV, finite };
}

console.log('== tuned defaults (strength 0.9, dist 40, dir 30) over 120 s ==');
const base = run(120);
console.log(`  recurrence median ${base.median.toFixed(1)} p90 ${base.p90.toFixed(1)}  locked ${(100*base.locked).toFixed(0)}%  engaged ${(100*base.engaged).toFixed(0)}%`);
console.log(`  bounds |x|<${base.maxX.toFixed(0)} |y|<${base.maxY.toFixed(0)} v<${base.maxV.toFixed(0)}  finite=${base.finite}`);

console.log('== guidance disabled baseline (strength 0) ==');
const sim0 = new Reactor(); sim0.guideStrength = 0; sim0.predict();
const off = (() => { const s = sim0; const rec = []; const hist = []; let eng = 0, n = 0;
	for (let step = 0; step < 120 * 60; step++) { s.step(); if (step % 3) continue; const p = s.particle; let best = Infinity;
		for (let i = 0; i < hist.length; i++) { const q = hist[i]; const age = s.time - q.time; if (age < 3 || age > 15) continue; if (p.vx*q.vx+p.vy*q.vy<=0) continue; best = Math.min(best, Math.hypot(Math.hypot(p.x-q.x,p.y-q.y), Math.hypot(p.vx-q.vx,p.vy-q.vy)*0.75)); }
		if (s.time > 10 && Number.isFinite(best)) rec.push(best); hist.push({time:s.time,x:p.x,y:p.y,vx:p.vx,vy:p.vy}); while (hist.length && s.time-hist[0].time>15) hist.shift();
	}
	return medianP90(rec); })();
console.log(`  recurrence median ${off.median.toFixed(1)} p90 ${off.p90.toFixed(1)} (higher = no lock, expected)`);

console.log('== magnet perturbation at t=40: loop should re-acquire ==');
const pert = run(80, (sim, t) => {
	if (t >= 40 && t < 40 + 0.02) { sim.magnets[0].x += 60; sim.magnets[1].angle += 0.7; sim.predict(true); }
});
console.log(`  recurrence median ${pert.median.toFixed(1)} p90 ${pert.p90.toFixed(1)}  locked ${(100*pert.locked).toFixed(0)}%  finite=${pert.finite}`);

console.log('== determinism ==');
const a = new Reactor(), b = new Reactor();
a.guideStrength = b.guideStrength = 0.9; a.predict(); b.predict();
for (let i = 0; i < 120 * 40; i++) { a.step(); b.step(); }
console.log(`  identical after 40 s: ${JSON.stringify(a.particle) === JSON.stringify(b.particle) && a.loop.count === b.loop.count}`);

console.log('== stability objective (targets within ±30%, cooling < 1.5%) ==');
const simS = new Reactor(); simS.guideStrength = 0.9; simS.predict();
for (let i = 0; i < 120 * 60; i++) simS.step();
console.log(`  stableTime ${simS.stableTime.toFixed(1)} s (>=8 means objective reached)`);
for (const t of simS.targets) console.log(`  target ${t.name}: actual ${(100*t.actual/t.desired-1).toFixed(0)}% dev`);
console.log(`  cooling ${(100*simS.cooling).toFixed(2)}%`);
