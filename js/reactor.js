(function (root) {
	'use strict';
	const DT = 1 / 120;
	const FORECAST_DT = 1 / 40;
	const FORECAST_PERIOD = 0.6;
	const SAMPLES = 561;
	const TAU = Math.PI * 2;
	const MAX_GRAZING_SINE = Math.sin(25 * Math.PI / 180);
	const GUIDE_ACCELERATION_PER_PIXEL = 0.5;
	const MAX_GUIDE_ACCELERATION = 50;
	// The live beam and the forecast are guided by a committed plan instead of by the newest
	// prediction. A plan derived from the beam is already its own ballistic continuation, which
	// makes zero force a fixed point: guiding against the newest plan would only ever see the beam
	// sitting exactly on its own extrapolation. Holding a plan for a while restores real error terms
	// whenever the beam or the field changes, and it keeps the route evolving smoothly.
	const PLAN_LAG_DEFAULT = 1.8;
	// The projection search walks this arc length around its seed per step. Wide is used once per
	// plan change to re-seat onto the new reference, then trimmed to the beam's plausible advance.
	const GUIDE_BACKTRACK = 8;
	const GUIDE_BACKTRACK_TIME = 0.1;
	const GUIDE_ADVANCE = 24;
	const GUIDE_ADVANCE_TIME = 0.25;
	const WIDE_MINIMUM = 60;
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	const smoothstep = value => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };

	function circleFraction(ax, ay, bx, by, cx, cy, radius) {
		const dx = bx - ax, dy = by - ay;
		const ox = ax - cx, oy = ay - cy;
		const a = dx * dx + dy * dy;
		const c = ox * ox + oy * oy - radius * radius;
		if (a < 1e-12) return c <= 0 ? 1 : 0;
		const b = 2 * (ox * dx + oy * dy);
		const discriminant = b * b - 4 * a * c;
		if (discriminant <= 0) return 0;
		const span = Math.sqrt(discriminant);
		return Math.max(0, Math.min(1, (-b + span) / (2 * a)) - Math.max(0, (-b - span) / (2 * a)));
	}

	function makePath() {
		return {
			x: new Float64Array(SAMPLES), y: new Float64Array(SAMPLES), t: new Float64Array(SAMPLES), s: new Float64Array(SAMPLES),
			forceX: new Float64Array(SAMPLES), forceY: new Float64Array(SAMPLES), count: 0
		};
	}

	// Anchor of a beam on a reference plan: the fractional position of its projection plus the
	// interpolated point, the local route speed and the cross-track distance.
	function makeGuide() {
		return { segment: -1, x: 0, y: 0, s: 0, speed: 0, distance: 0, wide: true };
	}

	function resetGuide(guide) { guide.segment = -1; guide.x = 0; guide.y = 0; guide.s = 0; guide.speed = 0; guide.distance = 0; guide.wide = true; }

	function pathLength(path) {
		path.s[0] = 0;
		for (let i = 1; i < SAMPLES; i++) path.s[i] = path.s[i - 1] + Math.hypot(path.x[i] - path.x[i - 1], path.y[i] - path.y[i - 1]);
	}

	function reflect(p, ax, ay, dt, reflector) {
		const tx = Math.cos(reflector.angle), ty = Math.sin(reflector.angle);
		const nx = -ty, ny = tx;
		const d0 = (ax - reflector.x) * nx + (ay - reflector.y) * ny;
		const d1 = (p.x - reflector.x) * nx + (p.y - reflector.y) * ny;
		if (d0 * d1 >= 0 || Math.abs(d0 - d1) < 1e-10) return false;
		const u = d0 / (d0 - d1);
		const ix = ax + (p.x - ax) * u, iy = ay + (p.y - ay) * u;
		if (Math.abs((ix - reflector.x) * tx + (iy - reflector.y) * ty) > reflector.length / 2) return false;
		const stepX = p.x - ax, stepY = p.y - ay;
		const stepLength = Math.hypot(stepX, stepY);
		if (stepLength < 1e-10) return false;
		if (Math.abs(stepX * nx + stepY * ny) > stepLength * MAX_GRAZING_SINE) return false;
		const normalSpeed = p.vx * nx + p.vy * ny;
		p.vx -= 2 * normalSpeed * nx;
		p.vy -= 2 * normalSpeed * ny;
		p.x = ix + p.vx * dt * (1 - u);
		p.y = iy + p.vy * dt * (1 - u);
		return true;
	}

	class Reactor {
		constructor() {
			this.scratch = { x: 0, y: 0, vx: 0, vy: 0 };
			this.particle = { x: 0, y: 0, vx: 0, vy: 0 };
			this.guideForce = { x: 0, y: 0 };
			this.guideAim = { x: 0, y: 0, segment: 0 };
			this.liveForce = { x: 0, y: 0 };
			this.liveDebug = {
				nearest: -1, target: -1, nx: 0, ny: 0, tx: 0, ty: 0,
				distance: 0, angle: 0, magnitude: 0, age: 0
			};
			this.liveGuide = makeGuide();
			this.forecastGuide = makeGuide();
			this.trailX = new Float64Array(900);
			this.trailY = new Float64Array(900);
			this.reset();
		}

		reset() {
			this.time = 0;
			this.guideStrength = 0.65;
			this.guideDistance = 100;
			this.guideDirection = 90;
			this.guideLookahead = 100;
			this.planLag = PLAN_LAG_DEFAULT;
			this.forecastClock = 0;
			this.stableTime = 0;
			this.cooling = 0;
			this.predictedCooling = 0;
			this.trailCount = 0;
			this.trailHead = 0;
			this.magnets = [
				{ x: 0, y: -270, angle: Math.PI / 2, polarity: 1, strength: 1, name: 'M1' },
				{ x: 350, y: 0, angle: Math.PI, polarity: -1, strength: 1, name: 'M2' },
				{ x: 0, y: 270, angle: -Math.PI / 2, polarity: 1, strength: 1, name: 'M3' },
				{ x: -350, y: 0, angle: 0, polarity: -1, strength: 1, name: 'M4' }
			];
			this.reflectors = [
				{ x: -150, y: -100, angle: -0.35, length: 105, name: 'R1' },
				{ x: 160, y: 110, angle: -0.5, length: 105, name: 'R2' }
			];
			this.targets = [
				{ x: -215, y: -80, radius: 38, desired: 0.065, actual: 0, predicted: 0, name: 'A' },
				{ x: 20, y: -175, radius: 38, desired: 0.065, actual: 0, predicted: 0, name: 'B' },
				{ x: 210, y: 65, radius: 38, desired: 0.065, actual: 0, predicted: 0, name: 'C' }
			];
			this.zones = [
				{ x: -85, y: 80, radius: 45 },
				{ x: 105, y: -55, radius: 42 }
			];
			Object.assign(this.particle, { x: -230, y: 0, vx: 0, vy: -151 });
			this.liveForce.x = 0; this.liveForce.y = 0;
			this.liveDebug.nearest = -1; this.liveDebug.target = -1;
			resetGuide(this.liveGuide);
			resetGuide(this.forecastGuide);
			this.path = makePath();
			this.sparePath = makePath();
			this.reference = makePath();
			this.referenceTime = 0;
			this.referenceAge = 0;
			this.predict();
		}

		// Node of the reference plan scheduled for `offset` seconds from now. The plan carries
		// absolute timestamps, so the corresponding point is known by the clock and a self-crossing
		// pass or a nearby older loop can never capture the beam.
		seedIndex(route, offset) {
			if (route.count < 2) return 0;
			return clamp(Math.round((this.time + offset - route.t[0]) / FORECAST_DT), 0, route.count - 2);
		}

		// Project the beam onto the reference plan and keep the projection moving forward along it.
		// The window is seeded on the scheduled node and prefers the nearest segment that continues
		// the beam's current heading, so an opposing or perpendicular pass cannot pull it backwards.
		// Guidance stays off when no forward route exists nearby rather than guessing a correction.
		findGuidePoint(p, route, state, seed) {
			const anchored = state.segment >= 0;
			state.segment = -1;
			if (route.count < 2) return false;
			const speed = Math.hypot(p.vx, p.vy);
			if (speed < 1e-8) return false;
			const ux = p.vx / speed, uy = p.vy / speed;
			const wide = state.wide;
			const center = wide || !anchored ? seed : state.segment;
			const centerS = wide || !anchored ? route.s[seed] : state.s;
			const reach = wide ? Math.max(WIDE_MINIMUM, this.guideDistance) : 0;
			const back = reach || Math.max(GUIDE_BACKTRACK, speed * GUIDE_BACKTRACK_TIME);
			const ahead = reach || Math.max(GUIDE_ADVANCE, speed * GUIDE_ADVANCE_TIME);
			const backLimit = centerS - back;
			const forwardLimit = centerS + ahead;
			let first = center;
			while (first > 0 && route.s[first] > backLimit) first--;
			let best = -1, bestU = 0, bestDistance2 = Infinity;
			for (let i = first; i < route.count - 1; i++) {
				if (i > first && route.s[i] > forwardLimit) break;
				const ax = route.x[i], ay = route.y[i];
				const dx = route.x[i + 1] - ax, dy = route.y[i + 1] - ay;
				const length2 = dx * dx + dy * dy;
				if (length2 < 1e-12) continue;
				if (ux * dx + uy * dy <= 0) continue;
				const u = clamp(((p.x - ax) * dx + (p.y - ay) * dy) / length2, 0, 1);
				const cx = ax + dx * u, cy = ay + dy * u;
				const distance2 = (cx - p.x) * (cx - p.x) + (cy - p.y) * (cy - p.y);
				if (distance2 >= bestDistance2) continue;
				best = i; bestU = u; bestDistance2 = distance2;
			}
			if (best < 0) return false;
			const span = route.s[best + 1] - route.s[best];
			const step = route.t[best + 1] - route.t[best];
			state.segment = best;
			state.x = route.x[best] + (route.x[best + 1] - route.x[best]) * bestU;
			state.y = route.y[best] + (route.y[best + 1] - route.y[best]) * bestU;
			state.s = route.s[best] + span * bestU;
			state.speed = step > 1e-9 ? span / step : 0;
			state.distance = Math.sqrt(bestDistance2);
			state.wide = false;
			return true;
		}

		// Point at a given arc length ahead of the anchor, interpolated between plan samples.
		aimPoint(route, state, distance, out) {
			const target = state.s + distance;
			let i = state.segment;
			while (i < route.count - 2 && route.s[i + 1] < target) i++;
			const span = route.s[i + 1] - route.s[i];
			const u = span > 1e-9 ? clamp((target - route.s[i]) / span, 0, 1) : 0;
			out.x = route.x[i] + (route.x[i + 1] - route.x[i]) * u;
			out.y = route.y[i] + (route.y[i + 1] - route.y[i]) * u;
			out.segment = i;
			return out;
		}

		guidanceVector(p, route, guidance, debug, state, seed) {
			const force = this.guideForce;
			force.x = 0; force.y = 0;
			// Keep the overlay honest: nothing is reported unless this step really guided.
			if (debug) debug.nearest = -1;
			if (route.count < 2 || guidance <= 0 || this.guideDistance <= 0 || this.guideDirection <= 0) return force;
			const speed = Math.hypot(p.vx, p.vy);
			if (speed < 1e-8) return force;
			if (!this.findGuidePoint(p, route, state, seed)) return force;
			const ux = p.vx / speed, uy = p.vy / speed;

			const lookaheadDistance = Math.max(2, this.guideLookahead * 0.001 * state.speed);
			const aim = this.aimPoint(route, state, lookaheadDistance, this.guideAim);
			const routeX = aim.x - state.x, routeY = aim.y - state.y;
			const routeLength = Math.hypot(routeX, routeY);
			if (routeLength < 1e-6) return force;
			const angleLimit = this.guideDirection * Math.PI / 180;
			const alignment = clamp((p.vx * routeX + p.vy * routeY) / (speed * routeLength), -1, 1);
			const angle = Math.acos(alignment);
			if (angle >= angleLimit) return force;
			if (state.distance >= this.guideDistance) return force;

			// Steering only: keep the component of the correction lateral to the beam so guidance can
			// never thrust or brake along the beam's own velocity. Speed stays with speed regulation.
			const correctionX = aim.x - p.x, correctionY = aim.y - p.y;
			const along = correctionX * ux + correctionY * uy;
			const steerX = correctionX - along * ux, steerY = correctionY - along * uy;
			const steerLength = Math.hypot(steerX, steerY);
			if (steerLength < 1e-6) return force;

			const distanceFactor = 1 - smoothstep(state.distance / this.guideDistance);
			const directionFactor = 1 - smoothstep(angle / angleLimit);
			const magnitude = Math.min(MAX_GUIDE_ACCELERATION, steerLength * GUIDE_ACCELERATION_PER_PIXEL) *
				guidance * distanceFactor * directionFactor;
			force.x = steerX / steerLength * magnitude;
			force.y = steerY / steerLength * magnitude;
			if (debug) {
				debug.nearest = state.segment; debug.target = aim.segment;
				debug.nx = state.x; debug.ny = state.y;
				debug.tx = aim.x; debug.ty = aim.y;
				debug.distance = state.distance; debug.angle = angle; debug.magnitude = magnitude;
			}
			return force;
		}

		integrate(p, dt, route, guidance, forceOut, debug, state, seed) {
			const ax = p.x, ay = p.y;
			let fx = -0.39 * p.x, fy = -0.64 * p.y;
			for (let i = 0; i < this.magnets.length; i++) {
				const m = this.magnets[i];
				const dx = m.x - p.x, dy = m.y - p.y;
				const distance = Math.hypot(dx, dy) || 1;
				const ux = dx / distance, uy = dy / distance;
				const mx = Math.cos(m.angle), my = Math.sin(m.angle);
				const alignment = -ux * mx - uy * my;
				const force = m.strength * m.polarity * 2800000 / (distance * distance + 18000);
				fx += force * (ux * alignment + mx * 0.25);
				fy += force * (uy * alignment + my * 0.25);
			}
			if (forceOut) { forceOut.x = 0; forceOut.y = 0; }
			if (route.count > 1 && guidance > 0) {
				const force = this.guidanceVector(p, route, guidance, debug, state, seed);
				fx += force.x; fy += force.y;
				if (forceOut) { forceOut.x = force.x; forceOut.y = force.y; }
			}
			// Soft containment; the chamber walls are not reflecting surfaces.
			fx -= Math.sign(p.x) * Math.max(0, Math.abs(p.x) - 285) * 4;
			fy -= Math.sign(p.y) * Math.max(0, Math.abs(p.y) - 210) * 4;
			const speed = Math.hypot(p.vx, p.vy);
			const regulation = (145 - speed) * 0.12 / (speed || 1);
			p.vx += (fx + p.vx * regulation) * dt;
			p.vy += (fy + p.vy * regulation) * dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			for (let i = 0; i < this.reflectors.length; i++) {
				if (reflect(p, ax, ay, dt, this.reflectors[i])) break;
			}
		}

		predict() {
			const next = this.sparePath, p = this.scratch, route = this.reference;
			Object.assign(p, this.particle);
			const guide = this.forecastGuide;
			resetGuide(guide);
			const base = this.seedIndex(route, 0);
			for (let i = 0; i < SAMPLES; i++) {
				next.x[i] = p.x; next.y[i] = p.y; next.t[i] = this.time + i * FORECAST_DT;
				if (i === SAMPLES - 1) { next.forceX[i] = 0; next.forceY[i] = 0; break; }
				const seed = Math.min(base + i, route.count - 2);
				for (let sub = 0; sub < 3; sub++) {
					const forceOut = sub === 0 ? this.guideForce : null;
					this.integrate(p, DT, route, this.guideStrength, forceOut, null, guide, seed);
					if (!forceOut) continue;
					next.forceX[i] = forceOut.x; next.forceY[i] = forceOut.y;
				}
			}
			pathLength(next);
			next.count = SAMPLES;
			const previous = this.path;
			this.path = next;
			this.sparePath = previous;
			// Commit the plan as the route the beam follows, then hold it for the selected memory.
			// The hold quantises to the refresh period, so a plan is adopted at the nearest refresh
			// boundary instead of drifting by a frame. While the clock stands still (field edits made
			// while paused) the route tracks the edit immediately: the beam is not flying.
			const elapsed = this.time - this.referenceTime;
			if (this.reference.count < 2 || elapsed <= 0 || elapsed >= this.planLag - DT) {
				this.reference.x.set(next.x); this.reference.y.set(next.y);
				this.reference.t.set(next.t); this.reference.s.set(next.s);
				this.reference.count = SAMPLES;
				this.referenceTime = this.time;
				// Re-seat the live anchor onto the new reference with a wide search window.
				this.liveGuide.segment = -1;
				this.liveGuide.wide = true;
			}
			this.referenceAge = this.reference.count > 1 ? this.time - this.referenceTime : 0;
			const horizon = next.t[SAMPLES - 1] - next.t[0];
			for (let i = 0; i < this.targets.length; i++) this.targets[i].predicted = this.pathDwell(this.targets[i]) / horizon;
			this.predictedCooling = 0;
			for (let i = 0; i < this.zones.length; i++) this.predictedCooling += this.pathDwell(this.zones[i]) / horizon;
		}

		pathDwell(circle) {
			let dwell = 0;
			const p = this.path;
			for (let i = 1; i < p.count; i++) dwell += circleFraction(p.x[i - 1], p.y[i - 1], p.x[i], p.y[i], circle.x, circle.y, circle.radius) * (p.t[i] - p.t[i - 1]);
			return dwell;
		}

		step() {
			const p = this.particle, ax = p.x, ay = p.y;
			this.integrate(p, DT, this.reference, this.guideStrength, this.liveForce, this.liveDebug, this.liveGuide, this.seedIndex(this.reference, 0));
			this.liveDebug.age = this.referenceAge;
			this.time += DT;
			const smoothing = 1 - Math.exp(-DT / 10);
			let balanced = this.time > 14;
			for (let i = 0; i < this.targets.length; i++) {
				const t = this.targets[i];
				const exposure = circleFraction(ax, ay, p.x, p.y, t.x, t.y, t.radius);
				t.actual += (exposure - t.actual) * smoothing;
				if (Math.abs(t.actual / t.desired - 1) > 0.3) balanced = false;
			}
			let exposure = 0;
			for (let i = 0; i < this.zones.length; i++) {
				const z = this.zones[i];
				exposure += circleFraction(ax, ay, p.x, p.y, z.x, z.y, z.radius);
			}
			this.cooling += (exposure - this.cooling) * smoothing;
			this.stableTime = balanced && this.cooling < 0.015 ? this.stableTime + DT : 0;
			this.trailX[this.trailHead] = p.x;
			this.trailY[this.trailHead] = p.y;
			this.trailHead = (this.trailHead + 1) % this.trailX.length;
			this.trailCount = Math.min(this.trailCount + 1, this.trailX.length);
			this.forecastClock += DT;
			if (this.forecastClock < FORECAST_PERIOD) return;
			this.forecastClock -= FORECAST_PERIOD;
			this.predict();
		}
	}
	const api = { Reactor, DT, TAU, circleFraction, reflect };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.ReactorCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
