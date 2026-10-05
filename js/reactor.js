(function (root) {
	'use strict';
	const DT = 1 / 120;
	const FORECAST_DT = 1 / 40;
	const SAMPLES = 561;
	const TAU = Math.PI * 2;
	const MAX_GRAZING_SINE = Math.sin(25 * Math.PI / 180);
	const GUIDANCE_DELAY = 2;
	const GUIDANCE_FADE = 1;
	const GUIDE_ACCELERATION_PER_PIXEL = 0.25;
	const MAX_GUIDE_ACCELERATION = 50;
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	const smoothstep = value => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
	const guidanceRamp = seconds => smoothstep((seconds - GUIDANCE_DELAY) / GUIDANCE_FADE);

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
			x: new Float64Array(SAMPLES), y: new Float64Array(SAMPLES), t: new Float64Array(SAMPLES),
			forceX: new Float64Array(SAMPLES), forceY: new Float64Array(SAMPLES), count: 0
		};
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
			this.path = makePath();
			this.sparePath = makePath();
			this.scratch = { x: 0, y: 0, vx: 0, vy: 0 };
			this.particle = { x: 0, y: 0, vx: 0, vy: 0 };
			this.guideForce = { x: 0, y: 0 };
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
			this.path.count = 0;
			this.predict();
		}

		guidanceVector(p, guide, guidance) {
			const force = this.guideForce;
			force.x = 0; force.y = 0;
			if (guide.count < 2 || guidance <= 0 || this.guideDistance <= 0 || this.guideDirection <= 0) return force;
			const speed = Math.hypot(p.vx, p.vy);
			if (speed < 1e-8) return force;

			let nearest = -1, nearestDistance2 = Infinity;
			for (let i = 0; i < guide.count; i++) {
				const dx = guide.x[i] - p.x, dy = guide.y[i] - p.y;
				const distance2 = dx * dx + dy * dy;
				if (distance2 >= nearestDistance2) continue;
				nearest = i; nearestDistance2 = distance2;
			}
			if (nearest < 0) return force;

			const lookaheadSamples = Math.max(1, Math.round(this.guideLookahead / (FORECAST_DT * 1000)));
			const targetIndex = Math.min(nearest + lookaheadSamples, guide.count - 1);
			if (targetIndex === nearest) return force;
			const routeX = guide.x[targetIndex] - guide.x[nearest];
			const routeY = guide.y[targetIndex] - guide.y[nearest];
			const routeLength = Math.hypot(routeX, routeY);
			if (routeLength < 1e-8) return force;

			const alignment = clamp((p.vx * routeX + p.vy * routeY) / (speed * routeLength), -1, 1);
			const angle = Math.acos(alignment);
			const angleLimit = this.guideDirection * Math.PI / 180;
			if (angle >= angleLimit) return force;
			const distance = Math.sqrt(nearestDistance2);
			if (distance >= this.guideDistance) return force;

			const targetX = guide.x[targetIndex] - p.x;
			const targetY = guide.y[targetIndex] - p.y;
			const targetDistance = Math.hypot(targetX, targetY);
			if (targetDistance < 1e-8) return force;
			const distanceFactor = 1 - smoothstep(distance / this.guideDistance);
			const directionFactor = 1 - smoothstep(angle / angleLimit);
			const magnitude = Math.min(MAX_GUIDE_ACCELERATION, targetDistance * GUIDE_ACCELERATION_PER_PIXEL) *
				guidance * distanceFactor * directionFactor;
			force.x = targetX / targetDistance * magnitude;
			force.y = targetY / targetDistance * magnitude;
			return force;
		}

		integrate(p, dt, guide, guidance, forceOut) {
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
			if (guide.count > 1 && guidance > 0) {
				const force = this.guidanceVector(p, guide, guidance);
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
			const next = this.sparePath, p = this.scratch;
			Object.assign(p, this.particle);
			for (let i = 0; i < SAMPLES; i++) {
				next.x[i] = p.x; next.y[i] = p.y; next.t[i] = this.time + i * FORECAST_DT;
				if (i === SAMPLES - 1) { next.forceX[i] = 0; next.forceY[i] = 0; break; }
				// Delay feedback in the near forecast so guidance cannot immediately chase its own path.
				for (let sub = 0; sub < 3; sub++) {
					const futureSeconds = i * FORECAST_DT + sub * DT;
					const forceOut = sub === 0 ? this.guideForce : null;
					this.integrate(p, DT, this.path, this.guideStrength * guidanceRamp(futureSeconds), forceOut);
					if (!forceOut) continue;
					next.forceX[i] = forceOut.x; next.forceY[i] = forceOut.y;
				}
			}
			next.count = SAMPLES;
			this.sparePath = this.path;
			this.path = next;
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
			this.integrate(p, DT, this.path, this.guideStrength);
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
			if (this.forecastClock < 0.6) return;
			this.forecastClock -= 0.6;
			this.predict();
		}
	}
	const api = { Reactor, DT, TAU, circleFraction, reflect, guidanceRamp };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.ReactorCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
