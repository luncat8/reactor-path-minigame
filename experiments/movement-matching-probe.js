'use strict';
// Confirms movement matching actually uses *other* laps of the committed route, not just the
// sample scheduled for the beam's own elapsed clock time, and that doing so finds a tighter match
// than the old clock-seeded window ever could. Not loaded by the page.
const { Reactor } = require('../js/reactor.js');

const FORECAST_DT = 1 / 40;

// What the old 0.1.4/0.1.5 search would have anchored to: the sample timestamped for "now".
function scheduledDistance(route, time, p) {
	const index = Math.max(0, Math.min(route.count - 1, Math.round((time - route.t[0]) / FORECAST_DT)));
	return Math.hypot(route.x[index] - p.x, route.y[index] - p.y);
}

function run(seconds, guideStrength) {
	const sim = new Reactor();
	sim.guideStrength = guideStrength;
	let crossLap = 0, tighter = 0, samples = 0;
	let sumScheduled = 0, sumMatched = 0;
	for (let i = 0; i < Math.round(seconds * 120); i++) {
		sim.step();
		const d = sim.liveDebug;
		if (d.nearest < 0) continue;
		samples++;
		const route = sim.reference;
		const matchedTime = route.t[d.nearest];
		const scheduled = scheduledDistance(route, sim.time, sim.particle);
		sumScheduled += scheduled; sumMatched += d.distance;
		if (Math.abs(matchedTime - sim.time) > 2) crossLap++;
		if (d.distance < scheduled - 1e-6) tighter++;
	}
	return { samples, crossLap, tighter, avgScheduled: sumScheduled / samples, avgMatched: sumMatched / samples };
}

console.log('== movement matching vs clock-seeded anchor, 90 s, default field ==');
for (const guideStrength of [0, 0.65, 1.2]) {
	const r = run(90, guideStrength);
	console.log(`  guidance ${guideStrength.toFixed(2)}: ${r.samples} samples, ${r.crossLap} anchored >2s from "now" (${(100 * r.crossLap / r.samples).toFixed(1)}%), ` +
		`${r.tighter} tighter than the clock-seeded sample (${(100 * r.tighter / r.samples).toFixed(1)}%), avg off-route matched ${r.avgMatched.toFixed(2)}px vs clock-seeded ${r.avgScheduled.toFixed(2)}px`);
}
