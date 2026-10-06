# Reactor path minigame

A dependency-free HTML/JavaScript experiment: tune a single beam's evolving orbit with magnets and grazing-angle reflectors. Activate three targets evenly while avoiding transparent cooling zones.

## Run

Open **`index.html`** in a modern browser. No installation, build, network access, or server is required.

For a local HTTP preview, optionally run:

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

## Controls

- Select M1–M4 or R1–R2 on the canvas or in the instrument panel.
- Drag inside a magnet to move it around the chamber frame. Drag outside the selected instrument to rotate it; the orientation slider and mouse wheel also work. Magnets have strength and polarity controls.
- With the canvas focused: **Q / E** rotates; **Right / Down** moves the selected magnet clockwise; **Left / Up** moves it counterclockwise; **Space** pauses.
- Reflectors stay in fixed positions and rotate. They reflect crossings below 25° relative to their surface; steeper crossings pass through.
- **Pause**, **Step**, and **Reset experiment** support inspection. Field edits update the forecast while paused. Reset preserves pause state.

## Trajectory guidance

Guidance now seeks a **future return state** that can close the orbit instead of projecting onto the immediate path beside the particle:

1. Every forecast sample stores position, time, and movement vector.
2. The next 2 seconds are excluded by default. Influence fades in over the following second, preventing the current outgoing branch from selecting itself. **Ignore near future** changes that 2-second exclusion.
3. All remaining forecast segments within the selected reach are searched. The selected point is interpolated on a segment and minimizes a phase-space score containing position and velocity error. Opposing and perpendicular movement is ineligible, so a closer wrong-way branch at a crossing cannot capture the particle.
4. A bounded damped controller combines position pull with movement matching. It gently turns, accelerates, or brakes the particle toward both the target position and its target velocity. **Movement matching** adjusts the velocity term; distance and direction controls fade implausible matches.
5. Forecast feedback is resolved with two reusable prediction passes every 0.6 seconds. No particle teleportation or direct velocity snapping occurs.

Only **future** forecast states are eligible. Past points were deliberately rejected: they turn the guide into a history rail after a field edit and make a nearby outgoing branch compete with the return branch. A future target expresses the intended next traversal and remains useful for loop closure.

Enable **Show guidance state and forces** to inspect the exact decision:

- green ring: selected future return position, on the cyan trajectory;
- green arrow: movement vector at that target;
- cyan arrow: current particle movement vector;
- dashed amber line: position error;
- white arrow: actual combined position/velocity matching force;
- amber arrows: guide forces used while generating the forecast;
- numeric readout: target lead time, position error, movement speed/angle error, and force.

The white arrow is hidden below magnitude 0.25 to avoid enlarging numerical dust; the readout still reports the exact value. Arrow lengths use a square-root scale.

## Read the chamber

- Thin cyan line: finite **14-second forecast**, refreshed every 0.6 simulation seconds.
- Bright line: recent actual beam history; bright dot: live particle.
- Target bars next to the circles: **predicted percentage deviation** from each target's requested duty cycle.
- Side panel: **live activation deviation**, exponentially smoothed with a 10-second time constant. A zero deviation means the target receives its requested 6.5% beam occupancy. Bars' midpoint marks that goal.
- Hatched amber zones: cooling exposure; they do not reflect the particle.
- Stability requires all live targets within ±30% of requested activation and cooling exposure below 1.5%, sustained for eight seconds after the initial 14-second warmup.

This is a gameplay field model, not a physical reactor simulation. A weak anisotropic restoring field, soft boundary confinement, and gentle speed regulation keep the experiment in the chamber. Magnet orientation modulates a softened directional field; reversing polarity reverses its force.

## Development

- `draft.txt` — original concept.
- `0.1-plan.md` — standalone development plan.
- `js/reactor.js` — deterministic fixed-step simulation, forecast buffers, guidance, collision, and dwell geometry; also exported for Node.
- `js/app.js` — canvas renderer, controls, and fixed-step scheduler.
- `archive/*-worklog.md` — implementation and validation records.

Run the dependency-free checks:

```sh
node --test tests/*.test.js
node experiments/guidance-probe.js
```

`experiments/guidance-probe.js` reports synthetic target selection and compares phase recurrence with guidance disabled and enabled. `experiments/browser-smoke.js` is an optional Playwright smoke test; install Playwright outside the runtime tree and optionally supply `BROWSER_EXECUTABLE`.

## Prototype boundaries / next work

Scenario solvability and difficulty are not calibrated. The stable status exists, but no known winning control preset is supplied. The new guide improves phase recurrence at the default setting in the deterministic probe, but guide strength remains gameplay tuning rather than a physical constant. The next step is parameter sweeps and playtesting across magnet edits, target duties, and cooling exposure.

Dwell is integrated along each sampled line segment using timestamp intervals. The live path uses 120 Hz steps; the forecast stores 40 Hz samples. Curvature and within-step reflector kinks are therefore approximated by chords.
