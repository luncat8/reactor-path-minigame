(function (root) {
	'use strict';
	const DT = 1 / 120;
	const FORECAST_DT = 1 / 40;
	const FORECAST_PERIOD = 0.6;
	const SAMPLES = 561;
	const TAU = Math.PI * 2;
	const MAX_GRAZING_SINE = Math.sin(25 * Math.PI / 180);
	const GUIDE_POSITION_GAIN = 0.5;
	const GUIDE_PHASE_TIME = 0.75;
	const GUIDE_FADE_TIME = 1;
	const MAX_GUIDE_ACCELERATION = 50;
	const MIN_GUIDE_FORCE = 0.01;
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
			x: new Float64Array(SAMPLES), y: new Float64Array(SAMPLES),
			vx: new Float64Array(SAMPLES), vy: new Float64Array(SAMPLES), t: new Float64Array(SAMPLES),
			forceX: new Float64Array(SAMPLES), forceY: new Float64Array(SAMPLES), count: 0
		};
	}

	function makeTarget() {
		return {
			segment: -1, x: 0, y: 0, vx: 0, vy: 0, time: 0, lead: 0,
			distance: 0, angle: 0, speedError: 0, timeFactor: 0, score: Infinity
		};
	}

	function resetTarget(target) {
		target.segment = -1;
		target.score = Infinity;
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
			this.forecastForce = { x: 0, y: 0 };
			this.guideTarget = makeTarget();
			this.liveForce = { x: 0, y: 0 };
			this.liveDebug = {
				target: -1, tx: 0, ty: 0, tvx: 0, tvy: 0,
				distance: 0, angle: 0, speedError: 0, magnitude: 0,
				lead: 0, timeFactor: 0
			};
			this.trailX = new Float64Array(900);
			this.trailY = new Float64Array(900);
			this.reset();
		}

		reset() {
			this.time = 0;
			this.guideStrength = 0.65;
			this.guideDistance = 100;
			this.guideDirection = 90;
			this.guideVelocity = 0.35;
			this.guideDelay = 2;
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
			this.liveForce.x = 0;
			this.liveForce.y = 0;
			this.liveDebug.target = -1;
			this.path = makePath();
			this.sparePath = makePath();
			this.proposalPath = makePath();
			this.predict();
		}

		// Select the nearest compatible state, not merely the nearest crossing. Recent future is
		// excluded so the guide seeks a return pass capable of closing the orbit.
		findGuideTarget(p, route, queryTime, out) {
			resetTarget(out);
			if (route.count < 2 || this.guideDelay < 0) return false;
			const speed = Math.hypot(p.vx, p.vy);
			if (speed < 1e-8) return false;
			const earliest = queryTime + this.guideDelay;
			const angleLimit = Math.min(Math.PI / 2, this.guideDirection * Math.PI / 180);
			const minimumCosine = Math.cos(angleLimit);
			for (let i = 0; i < route.count - 1; i++) {
				const t0 = route.t[i], t1 = route.t[i + 1];
				if (t1 <= earliest || t1 <= t0) continue;
				const dx = route.x[i + 1] - route.x[i], dy = route.y[i + 1] - route.y[i];
				const length2 = dx * dx + dy * dy;
				if (length2 < 1e-12) continue;
				const minimumU = clamp((earliest - t0) / (t1 - t0), 0, 1);
				const u = clamp(((p.x - route.x[i]) * dx + (p.y - route.y[i]) * dy) / length2, minimumU, 1);
				const x = route.x[i] + dx * u, y = route.y[i] + dy * u;
				const vx = route.vx[i] + (route.vx[i + 1] - route.vx[i]) * u;
				const vy = route.vy[i] + (route.vy[i + 1] - route.vy[i]) * u;
				const targetSpeed = Math.hypot(vx, vy);
				if (targetSpeed < 1e-8) continue;
				const cosine = clamp((p.vx * vx + p.vy * vy) / (speed * targetSpeed), -1, 1);
				if (cosine <= minimumCosine || cosine <= 0) continue;
				const angle = Math.acos(cosine);
				const positionX = x - p.x, positionY = y - p.y;
				const velocityX = vx - p.vx, velocityY = vy - p.vy;
				const distance2 = positionX * positionX + positionY * positionY;
				if (distance2 >= this.guideDistance * this.guideDistance) continue;
				const speedError2 = velocityX * velocityX + velocityY * velocityY;
				const time = t0 + (t1 - t0) * u;
				const lead = time - queryTime;
				const timeFactor = smoothstep((lead - this.guideDelay) / GUIDE_FADE_TIME);
				if (timeFactor <= 0) continue;
				const temporalWeight = 0.05 + 0.95 * timeFactor;
				const score = (distance2 + speedError2 * GUIDE_PHASE_TIME * GUIDE_PHASE_TIME) /
					(temporalWeight * temporalWeight);
				if (score >= out.score) continue;
				out.segment = i;
				out.x = x; out.y = y; out.vx = vx; out.vy = vy;
				out.time = time; out.lead = lead;
				out.distance = Math.sqrt(distance2);
				out.angle = angle;
				out.speedError = Math.sqrt(speedError2);
				out.timeFactor = timeFactor;
				out.score = score;
			}
			return out.segment >= 0;
		}

		// A damped phase-state controller closes both errors: position pulls toward the green target,
		// while velocity matching turns and accelerates the beam into the target's movement state.
		guidanceVector(p, route, queryTime, guidance, debug) {
			const force = this.guideForce;
			force.x = 0; force.y = 0;
			if (debug) { debug.target = -1; debug.magnitude = 0; }
			if (route.count < 2 || guidance <= 0 || this.guideDistance <= 0 || this.guideDirection <= 0) return force;
			const target = this.guideTarget;
			if (!this.findGuideTarget(p, route, queryTime, target)) return force;
			const distanceFactor = 1 - smoothstep(target.distance / this.guideDistance);
			const angleLimit = Math.min(Math.PI / 2, this.guideDirection * Math.PI / 180);
			const directionFactor = 1 - smoothstep(target.angle / angleLimit);
			let fx = (target.x - p.x) * GUIDE_POSITION_GAIN + (target.vx - p.vx) * this.guideVelocity;
			let fy = (target.y - p.y) * GUIDE_POSITION_GAIN + (target.vy - p.vy) * this.guideVelocity;
			const scale = guidance * distanceFactor * directionFactor * target.timeFactor;
			fx *= scale; fy *= scale;
			const length = Math.hypot(fx, fy);
			const magnitude = Math.min(MAX_GUIDE_ACCELERATION, length);
			if (debug) {
				debug.target = target.segment;
				debug.tx = target.x; debug.ty = target.y;
				debug.tvx = target.vx; debug.tvy = target.vy;
				debug.distance = target.distance; debug.angle = target.angle;
				debug.speedError = target.speedError; debug.lead = target.lead;
				debug.timeFactor = target.timeFactor;
				debug.magnitude = magnitude >= MIN_GUIDE_FORCE ? magnitude : 0;
			}
			if (magnitude < MIN_GUIDE_FORCE) return force;
			const limit = magnitude / length;
			force.x = fx * limit;
			force.y = fy * limit;
			return force;
		}

		integrate(p, dt, route, guidance, forceOut, debug, queryTime) {
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
				const force = this.guidanceVector(p, route, queryTime === undefined ? this.time : queryTime, guidance, debug);
				fx += force.x; fy += force.y;
				if (forceOut) { forceOut.x = force.x; forceOut.y = force.y; }
			}
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

		forecastInto(next, route) {
			const p = this.scratch;
			Object.assign(p, this.particle);
			for (let i = 0; i < SAMPLES; i++) {
				next.x[i] = p.x; next.y[i] = p.y;
				next.vx[i] = p.vx; next.vy[i] = p.vy;
				next.t[i] = this.time + i * FORECAST_DT;
				if (i === SAMPLES - 1) { next.forceX[i] = 0; next.forceY[i] = 0; break; }
				for (let sub = 0; sub < 3; sub++) {
					const forceOut = sub === 0 ? this.forecastForce : null;
					this.integrate(p, DT, route, this.guideStrength, forceOut, null,
						this.time + i * FORECAST_DT + sub * DT);
					if (!forceOut) continue;
					next.forceX[i] = forceOut.x;
					next.forceY[i] = forceOut.y;
				}
			}
			next.count = SAMPLES;
		}

		predict() {
			// Two reusable passes resolve the forecast/guide feedback without guiding against a stale
			// committed route. The first pass proposes the path; the second follows that proposal.
			this.forecastInto(this.proposalPath, this.path);
			this.forecastInto(this.sparePath, this.proposalPath);
			const previous = this.path;
			this.path = this.sparePath;
			this.sparePath = previous;
			const live = this.guidanceVector(this.particle, this.path, this.time, this.guideStrength, this.liveDebug);
			this.liveForce.x = live.x; this.liveForce.y = live.y;
			const horizon = this.path.t[SAMPLES - 1] - this.path.t[0];
			for (let i = 0; i < this.targets.length; i++) this.targets[i].predicted = this.pathDwell(this.targets[i]) / horizon;
			this.predictedCooling = 0;
			for (let i = 0; i < this.zones.length; i++) this.predictedCooling += this.pathDwell(this.zones[i]) / horizon;
		}

		pathDwell(circle) {
			let dwell = 0;
			const p = this.path;
			for (let i = 1; i < p.count; i++) {
				dwell += circleFraction(p.x[i - 1], p.y[i - 1], p.x[i], p.y[i], circle.x, circle.y, circle.radius) *
					(p.t[i] - p.t[i - 1]);
			}
			return dwell;
		}

		step() {
			const p = this.particle, ax = p.x, ay = p.y;
			this.integrate(p, DT, this.path, this.guideStrength, this.liveForce, this.liveDebug, this.time);
			this.time += DT;
			const force = this.guidanceVector(p, this.path, this.time, this.guideStrength, this.liveDebug);
			this.liveForce.x = force.x; this.liveForce.y = force.y;
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
