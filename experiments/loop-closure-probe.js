'use strict';
// Measures whether movement-matching guidance actually closes the beam's path into a stable,
// repeating loop, as opposed to an ever-drifting open curve. Not loaded by the page.
const { Reactor } = require('../js/reactor.js');

// Record the beam's state every time it crosses the +x axis heading upward: one marker per
// revolution. A closed loop makes successive crossings converge to the same point and interval;
// an open, drifting curve keeps crossing at new positions indefinitely.
function crossings(seconds, guideStrength) {
	const sim = new Reactor();
	sim.guideStrength = guideStrength;
	const marks = [];
	let previousY = sim.particle.y;
	for (let i = 0; i < Math.round(seconds / 0.0083333); i++) {
		sim.step();
		const p = sim.particle;
		if (previousY < 0 && p.y >= 0 && p.x > 0) marks.push({ t: sim.time, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
		previousY = p.y;
	}
	return marks;
}

function drift(marks) {
	const d = [];
	for (let i = 1; i < marks.length; i++) d.push(Math.hypot(marks[i].x - marks[i - 1].x, marks[i].y - marks[i - 1].y));
	return d;
}

console.log('== lap-to-lap drift at the +x axis crossing, guided vs unguided (120 s) ==');
for (const guideStrength of [0, 0.65, 1.2]) {
	const marks = crossings(120, guideStrength);
	const d = drift(marks);
	const early = d.slice(0, Math.max(1, Math.floor(d.length / 3)));
	const late = d.slice(-Math.max(1, Math.floor(d.length / 3)));
	const avg = arr => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
	console.log(`  guidance ${guideStrength.toFixed(2)}: ${marks.length} laps, drift early ${avg(early).toFixed(1)}px -> late ${avg(late).toFixed(1)}px (per-lap: ${d.map(v => v.toFixed(1)).join(' ')})`);
}

console.log('== target duty stabilization over 60 s, guided vs unguided ==');
for (const guideStrength of [0, 0.65]) {
	const sim = new Reactor();
	sim.guideStrength = guideStrength;
	for (let i = 0; i < 120 * 60; i++) sim.step();
	const duties = sim.targets.map(t => (100 * (t.actual / t.desired - 1)).toFixed(0) + '%');
	console.log(`  guidance ${guideStrength.toFixed(2)}: deviations ${duties.join(', ')}  cooling ${(sim.cooling * 100).toFixed(2)}%  stable ${sim.stableTime.toFixed(1)}s`);
}
