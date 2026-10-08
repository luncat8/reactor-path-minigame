'use strict';
// Search for a shippable winning preset: a magnet/reflector layout whose loop-lock
// orbit holds every live target within ±30% of its requested duty and cooling below
// 1.5% long enough for REACTOR STABLE (8 s). Only UI-reachable layouts are searched:
// magnets on the chamber perimeter (the app's arc-length parameterisation), strength
// on the 0–2 slider, polarity ±1, reflectors at their fixed pivots. Guidance stays at
// the tuned defaults (strength 0.9, 40 px, 30°). Not loaded by the page. Usage:
//   node experiments/preset-search.js [--seeds=24] [--budget=150] [--screen=240] [--verify=300] [--workers=2] [--rngSeed=20261007]
// Refinement rounds resume from previous logs' verified candidates (comma-separated):
//   node experiments/preset-search.js --resume=experiments/logs/preset-search.json,experiments/logs/preset-search-r2.json --screen=200 --verify=300 --out=preset-search-r4
// Deterministic: every descent depends only on rngSeed, the seed list, and --budget.
const fs = require('node:fs');
const path = require('node:path');
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { Reactor } = require('../js/reactor.js');

const PERIMETER = 2480;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Same frame walk as the app's keyboard moves: top, right, bottom, left edge.
function perimeterPoint(s) {
	s = ((s % PERIMETER) + PERIMETER) % PERIMETER;
	if (s < 700) return { x: s - 350, y: -270 };
	if (s < 1240) return { x: 350, y: s - 970 };
	if (s < 1940) return { x: 1590 - s, y: 270 };
	return { x: -350, y: 2210 - s };
}

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = a + 0x6D2B79F5 | 0;
		let t = Math.imul(a ^ a >>> 15, 1 | a);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

function cloneCfg(cfg) {
	return { magnets: cfg.magnets.map(m => ({ ...m })), reflectors: [...cfg.reflectors] };
}

function defaultCfg() {
	// Arc lengths of the shipped default: M1 top centre, M2 right centre, M3 bottom
	// centre, M4 left centre; reflector angles −0.35 and −0.5 rad.
	return {
		magnets: [
			{ s: 350, angle: Math.PI / 2, polarity: 1, strength: 1 },
			{ s: 970, angle: Math.PI, polarity: -1, strength: 1 },
			{ s: 1590, angle: -Math.PI / 2, polarity: 1, strength: 1 },
			{ s: 2210, angle: 0, polarity: -1, strength: 1 }
		],
		reflectors: [-0.35, -0.5]
	};
}

function applyCfg(sim, cfg) {
	for (let i = 0; i < 4; i++) {
		const m = sim.magnets[i], c = cfg.magnets[i], pt = perimeterPoint(c.s);
		m.x = pt.x; m.y = pt.y; m.angle = c.angle; m.polarity = c.polarity; m.strength = c.strength;
	}
	for (let j = 0; j < 2; j++) sim.reflectors[j].angle = cfg.reflectors[j];
}

// Screening score, lower is better. The game judges the live 10-second EMA against the
// ±30% band and the cooling EMA against 1.5%, and any excursion resets the 8-second
// stability streak — so the shippable quantity is the WORST value over a long horizon,
// not a snapshot. Locked rails on searched fields show a slow limit-cycle duty swing
// (measured: ±40% with a 60–120 s period, undamped over 600 s), so screening must span
// several cycles and score the worst EMA deviation and the worst cooling spike. A layout
// whose worst deviation stays inside the band never breaks the streak; one that merely
// ends inside it breaks every cycle. The ride wander (worst offset from the rail while
// riding) is the mechanism behind the swing — measured: near-diametral passages with
// low chord sensitivity still swing ±40% when the beam wanders 25–30 px across the pull
// tolerance, while the steady default lock wanders at most 14 px — so it earns a shaping
// term that gives the descent a smoother gradient than the worst deviation alone. Rail
// churn (fresh commits per second) is penalised likewise: a rail that keeps being
// replaced has not locked an orbit the field supports.
function scoreOf(worstDev, coolingSpike, engaged, churn, wanderMax) {
	return worstDev + 0.01 * wanderMax + 2 * Math.max(0, coolingSpike - 0.015) + 0.3 * coolingSpike +
		3 * Math.max(0, 0.75 - engaged) + churn;
}

function evaluate(cfg, screenSeconds) {
	const sim = new Reactor();
	sim.skipDisplayForecast = true;
	applyCfg(sim, cfg);
	sim.predict(true);
	// Rail churn: every commitLoop call replaces the committed shape with another
	// near-recurrence. A layout whose rail keeps being replaced has not locked an orbit.
	let commits = 0;
	const original = sim.commitLoop.bind(sim);
	sim.commitLoop = (route, pair) => { commits++; return original(route, pair); };
	// The EMA needs ~30 s to settle from the warmup state; the worst-case tracking then
	// runs to the end. Deviations sample every 0.6 s (72 steps), matching the refresh
	// the game uses; the ride offset is cheap to read, so it samples every step.
	let engaged = 0, samples = 0, worstDev = 0, coolingSpike = 0, wanderMax = 0;
	for (let i = 0; i < Math.round(120 * screenSeconds); i++) {
		sim.step();
		if (sim.time <= 30) continue;
		if (sim.liveDebug.engaged) wanderMax = Math.max(wanderMax, sim.liveDebug.distance);
		if (i % 72 === 0) {
			for (const t of sim.targets) worstDev = Math.max(worstDev, Math.abs(t.actual / t.desired - 1));
			coolingSpike = Math.max(coolingSpike, sim.cooling);
		}
		if (sim.time <= screenSeconds - 30) continue;
		samples++;
		if (sim.liveDebug.engaged) engaged++;
	}
	const churn = commits / screenSeconds;
	const result = { worstDev, coolingSpike, cooling: sim.cooling, wanderMax, engaged: samples ? engaged / samples : 0, churn };
	result.score = scoreOf(worstDev, coolingSpike, result.engaged, churn, wanderMax);
	return result;
}

// Full-fidelity confirmation: display forecast on, run to `seconds`, and require the
// game's win condition (an 8-second stability streak) on top of a band margin: the
// worst deviation and cooling spike over the run must stay inside the limits, so the
// streak is never broken by the rail's slow duty cycle.
function verify(cfg, seconds) {
	const sim = new Reactor();
	applyCfg(sim, cfg);
	sim.predict(true);
	let engaged = 0, samples = 0, maxStable = 0, worstDev = 0, coolingSpike = 0;
	for (let i = 0; i < Math.round(120 * seconds); i++) {
		sim.step();
		maxStable = Math.max(maxStable, sim.stableTime);
		if (i % 72 === 0 && sim.time >= 30) {
			for (const t of sim.targets) worstDev = Math.max(worstDev, Math.abs(t.actual / t.desired - 1));
			coolingSpike = Math.max(coolingSpike, sim.cooling);
		}
		if (sim.time <= 14) continue;
		samples++;
		if (sim.liveDebug.engaged) engaged++;
	}
	const devs = sim.targets.map(t => t.actual / t.desired - 1);
	return {
		devs, worstDev, coolingSpike, cooling: sim.cooling, stableTime: sim.stableTime, maxStable,
		engaged: samples ? engaged / samples : 0,
		period: sim.loop.count > 1 ? sim.loop.period : 0,
		// The preset must hold the balance through the limit cycle, not just touch it:
		// the worst deviation over the run has to stay inside the band with margin, so
		// the 8-second streak is never broken, and cooling must not spike either.
		pass: maxStable >= 8 && worstDev <= 0.3 && coolingSpike < 0.015
	};
}

// Ship granularity: integer pixel positions (drag reachable), integer degrees (slider
// step 1), strength on the 0.05 slider step. A preset only ships if the rounded
// layout still passes verification, so rounding is applied before the final check.
function roundCfg(cfg) {
	const out = { magnets: [], reflectors: [] };
	for (const m of cfg.magnets) {
		const pt = perimeterPoint(m.s);
		out.magnets.push({
			s: null, x: Math.round(pt.x), y: Math.round(pt.y),
			angleDeg: Math.round(m.angle * 180 / Math.PI),
			polarity: m.polarity < 0 ? -1 : 1,
			strength: Math.round(m.strength * 20) / 20
		});
	}
	for (const a of cfg.reflectors) out.reflectors.push(Math.round(a * 180 / Math.PI));
	return out;
}

function unroundCfg(rounded) {
	return {
		magnets: rounded.magnets.map(m => ({
			s: perimeterSOf(m.x, m.y), angle: m.angleDeg * Math.PI / 180,
			polarity: m.polarity, strength: m.strength
		})),
		reflectors: rounded.reflectors.map(d => d * Math.PI / 180)
	};
}

function perimeterSOf(x, y) {
	if (y === -270) return x + 350;
	if (x === 350) return 970 + y;
	if (y === 270) return 1590 - x;
	return 2210 - y;
}

function makeNeighbors(cfg, scale) {
	const out = [];
	const seen = new Set([JSON.stringify(cfg)]);
	const variant = mutate => {
		const c = cloneCfg(cfg);
		mutate(c);
		const key = JSON.stringify(c);
		if (!seen.has(key)) { seen.add(key); out.push(c); }
	};
	for (let i = 0; i < 4; i++) {
		for (const ds of [60, 20, -20, -60]) variant(c => { c.magnets[i].s += ds * scale; });
		for (const da of [0.35, 0.12, -0.12, -0.35]) variant(c => { c.magnets[i].angle += da * scale; });
		variant(c => { c.magnets[i].polarity *= -1; });
		for (const dk of [0.3, -0.3]) variant(c => { c.magnets[i].strength = clamp(c.magnets[i].strength + dk * scale, 0, 2); });
	}
	for (let j = 0; j < 2; j++) {
		for (const da of [0.3, -0.3, 0.1, -0.1]) variant(c => { c.reflectors[j] += da * scale; });
	}
	// Coarse two-magnet hops: the limit-cycle structure lives in the field's global shape,
	// and single-magnet moves rarely change which basin the descent sits in.
	if (scale === 1) {
		for (let a = 0; a < 4; a++) {
			for (let b = a + 1; b < 4; b++) {
				for (const ds of [70, -70]) {
					variant(c => { c.magnets[a].s += ds; c.magnets[b].s += ds; });
					variant(c => { c.magnets[a].s += ds; c.magnets[b].s -= ds; });
				}
			}
		}
	}
	return out;
}

// Steepest-descent sweeps at shrinking step scales. The score is noisy across layouts
// (chaotic fields), so accepting only the best neighbor per sweep keeps the walk from
// chasing single-evaluation luck.
function descend(seedCfg, screenSeconds, budget) {
	let best = cloneCfg(seedCfg);
	let bestEval = evaluate(best, screenSeconds);
	let evaluations = 1;
	for (const scale of [1, 0.35, 0.12]) {
		let improved = true;
		while (improved && evaluations < budget) {
			improved = false;
			let candidate = null, candidateEval = null;
			for (const n of makeNeighbors(best, scale)) {
				if (evaluations >= budget) break;
				evaluations++;
				const e = evaluate(n, screenSeconds);
				if (!candidateEval || e.score < candidateEval.score) { candidate = n; candidateEval = e; }
			}
			if (candidateEval && candidateEval.score < bestEval.score - 1e-4) {
				best = candidate;
				bestEval = candidateEval;
				improved = true;
			}
		}
		if (evaluations >= budget) break;
	}
	return { cfg: best, result: bestEval, evaluations };
}

// Fresh random layouts for basin diversity.
function makeRandomSeeds(count, rngSeed) {
	const rand = mulberry32(rngSeed + 101);
	const seeds = [];
	for (let i = 0; i < count; i++) {
		const cfg = { magnets: [], reflectors: [] };
		for (let k = 0; k < 4; k++) {
			cfg.magnets.push({ s: rand() * PERIMETER, angle: (rand() * 2 - 1) * Math.PI, polarity: rand() < 0.5 ? -1 : 1, strength: 0.5 + rand() });
		}
		for (let j = 0; j < 2; j++) cfg.reflectors.push(rand() < 0.5 ? [-0.35, -0.5][j] : (rand() * 2 - 1) * Math.PI);
		seeds.push({ cfg, origin: 'fresh' + i });
	}
	return seeds;
}

function makeSeeds(count, rngSeed) {
	const rand = mulberry32(rngSeed);
	const seeds = [];
	const hints = [
		() => defaultCfg(),
		() => { const c = defaultCfg(); c.magnets[3].s = 2290; return c; },   // M4 beside target A
		() => { const c = defaultCfg(); c.magnets[1].s = 1035; return c; },   // M2 beside target C
		() => { const c = defaultCfg(); c.magnets[3].s = 2290; c.magnets[1].s = 1035; return c; }
	];
	for (let i = 0; i < Math.min(count, hints.length); i++) seeds.push({ cfg: hints[i](), origin: 'hint' + i });
	for (let i = seeds.length; i < count; i++) {
		const cfg = { magnets: [], reflectors: [] };
		for (let k = 0; k < 4; k++) {
			cfg.magnets.push({
				s: rand() * PERIMETER,
				angle: (rand() * 2 - 1) * Math.PI,
				polarity: rand() < 0.5 ? -1 : 1,
				strength: 0.5 + rand()
			});
		}
		for (let j = 0; j < 2; j++) cfg.reflectors.push(rand() < 0.5 ? [-0.35, -0.5][j] : (rand() * 2 - 1) * Math.PI);
		seeds.push({ cfg, origin: 'random' + i });
	}
	return seeds;
}

function parseArgv(argv) {
	const opts = { seeds: 24, random: 0, budget: 150, screen: 240, verify: 300, workers: 2, rngSeed: 20261007, top: 8, resume: '', out: 'preset-search' };
	for (const arg of argv) {
		const match = /^--(\w+)=(.+)$/.exec(arg);
		if (!match) continue;
		const value = Number(match[2]);
		opts[match[1]] = Number.isNaN(value) ? match[2] : value;
	}
	return opts;
}

// A refinement round resumes from previous logs' verified candidates: their rounded
// (ship-granularity) layouts are the seeds, and the descent sharpens the best basins.
// Comma-separated files may mix rounds; duplicate layouts are kept once.
function resumeSeeds(files) {
	const seeds = [], seen = new Set();
	for (const file of files.split(',')) {
		const log = JSON.parse(fs.readFileSync(file, 'utf8'));
		for (const r of log.results) {
			const key = JSON.stringify(r.rounded);
			if (seen.has(key)) continue;
			seen.add(key);
			seeds.push({ cfg: unroundCfg(r.rounded), origin: 'r:' + r.origin });
		}
	}
	return seeds;
}

function runWorker() {
	const results = [];
	for (const job of workerData.jobs) {
		const t0 = Date.now();
		const descent = descend(job.cfg, workerData.screen, workerData.budget);
		results.push({ origin: job.origin, ...descent, ms: Date.now() - t0 });
	}
	parentPort.postMessage(results);
}

async function runMain(opts) {
	const seeds = opts.resume ? resumeSeeds(opts.resume) : makeSeeds(opts.seeds, opts.rngSeed);
	for (const fresh of makeRandomSeeds(opts.random, opts.rngSeed)) seeds.push(fresh);
	const workerCount = Math.max(1, Math.min(opts.workers, seeds.length));
	const chunks = [];
	for (let w = 0; w < workerCount; w++) {
		chunks.push(seeds.map((seed, i) => ({ ...seed, index: i })).filter((_, i) => i % workerCount === w));
	}
	const started = Date.now();
	const results = (await Promise.all(chunks.map(chunk => new Promise((resolve, reject) => {
		const worker = new Worker(__filename, { workerData: { jobs: chunk, screen: opts.screen, budget: opts.budget } });
		worker.once('message', resolve);
		worker.once('error', reject);
	})))).flat();
	results.sort((a, b) => a.result.score - b.result.score);
	console.log(`== screening: ${results.length} descents, ${results.reduce((n, r) => n + r.evaluations, 0)} evaluations @ ${opts.screen}s, ${((Date.now() - started) / 1000).toFixed(0)}s wall ==`);
	for (const r of results.slice(0, opts.top)) {
		console.log(`  ${r.origin.padEnd(9)} score ${r.result.score.toFixed(3)}  worstDev ${(r.result.worstDev * 100).toFixed(0)}%  wander ${r.result.wanderMax.toFixed(0)}px  coolSpike ${(r.result.coolingSpike * 100).toFixed(2)}%  eng ${(r.result.engaged * 100).toFixed(0)}%  churn ${r.result.churn.toFixed(2)}/s  (${r.evaluations} evals)`);
	}

	// Round to ship granularity, deduplicate, and verify the survivors at full fidelity.
	const seen = new Set();
	const candidates = [];
	for (const r of results) {
		const rounded = roundCfg(r.cfg);
		const key = JSON.stringify(rounded);
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ origin: r.origin, rounded, screenScore: r.result.score });
		if (candidates.length >= opts.top) break;
	}
	console.log(`== verification: full fidelity ${opts.verify}s, rounded to ship granularity ==`);
	const verified = [];
	for (const c of candidates) {
		const check = verify(unroundCfg(c.rounded), opts.verify);
		verified.push({ ...c, check });
		console.log(`  ${c.origin.padEnd(9)} ${check.pass ? 'PASS' : 'fail'}  worstDev ${(check.worstDev * 100).toFixed(0)}%  maxStable ${check.maxStable.toFixed(1)}s  devs [${check.devs.map(d => (d * 100).toFixed(0) + '%').join(' ')}]  coolSpike ${(check.coolingSpike * 100).toFixed(2)}%  eng ${(check.engaged * 100).toFixed(0)}%  loop ${check.period.toFixed(1)}s`);
	}
	const winners = verified.filter(v => v.check.pass)
		.sort((a, b) => a.check.worstDev - b.check.worstDev || b.check.maxStable - a.check.maxStable);
	const winner = winners[0] || null;
	if (winner) {
		console.log('== winner (ship-ready) ==');
		console.log(JSON.stringify(winner.rounded, null, '\t'));
	} else {
		console.log('== no candidate passed verification ==');
	}

	const logs = path.join(__dirname, 'logs');
	fs.mkdirSync(logs, { recursive: true });
	const logFile = path.join(logs, opts.out + '.json');
	fs.writeFileSync(logFile, JSON.stringify({ opts, startedAt: new Date(started).toISOString(), results: verified, winner }, null, '\t'));
	console.log(`log written: ${path.relative(process.cwd(), logFile)}`);
}

if (isMainThread) runMain(parseArgv(process.argv.slice(2)));
else runWorker();
