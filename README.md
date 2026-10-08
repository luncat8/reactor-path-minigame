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
- The **Speed** slider fast-forwards from the current 1x up to 50x. The simulation step stays fixed at 120 Hz and only the simulated time per real second changes, so the on-screen forecast refresh rate is unchanged.

## Trajectory guidance

Guidance works as a **loop-lock magnetic rail**: it finds the loop the field almost supports, commits it, and then completes it.

1. Every 0.6 s of real time the sim runs one *unguided* forecast pass (the simulation-time interval stretches with the speed slider). Its best near-recurrence — an earlier state that a later state returns to, anchored at the beam's own position — is the lap the field almost closes. Laps shorter than the **minimum loop period** are ignored, and opposing/perpendicular returns never count.
2. That lap is committed as the loop rail. Its closure error (the seam) is stitched smoothly into the lap so the rail is one closed curve; without the stitch the seam is wider than the pull tolerance and the beam would cross the junction unguided every lap.
3. The force pulls the beam toward the nearest compatible section of the rail and matches the local speed and heading, aiming slightly ahead so it joins the rail instead of braking against it. Pull acts only inside the **distance falloff** and **direction fade** tolerances (defaults 40 px / 30°) with full authority up to 75% of each, fading smoothly to exactly zero at them — so a crossing branch moving the wrong way can never capture the beam.
4. While the beam rides the rail, the committed shape is frozen and only the grace timer refreshes; a better-scoring loop elsewhere cannot hijack the ride. A rail that loses the beam re-locks onto the best new candidate after a short grace period, and an unrelated loop can capture the beam only when the forecast shows the beam reaching its entry within a few seconds.
5. A field edit while the beam rides *transports* the held lap: the rail's own entry state is propagated through the edited field for one period, the seam is stitched, and that lap is kept whenever the beam still meets it inside the pull tolerances. The rail therefore follows the edit — a nudge reshapes the orbit by about the size of the nudge — instead of being re-fitted from a forecast the guide has already pulled off course, which latched onto a different lap and swapped the orbit. An edit that moves the orbit out from under the beam fails that test, and the search re-derives the rail from the beam's own next lap.
6. A second *guided* forecast pass follows the committed loop, so the displayed cyan forecast matches the forces the beam will actually feel. No particle teleportation or velocity snapping occurs.

The unguided first pass keeps detection honest: it never depends on the guide's own limited authority, and the rail evolves smoothly with field edits instead of becoming a stale history line.

Enable **Show guidance state and forces** to inspect the exact decision:

- green closed curve: the committed loop rail;
- green ring: the aim point on the rail (slightly ahead of the nearest section);
- green arrow: rail movement at the aim point;
- cyan arrow: current particle movement vector;
- dashed amber line: beam offset to the rail;
- white arrow: actual matching force;
- amber arrows: guide forces used while generating the forecast;
- numeric readout: loop period, riding/seeking state, rail offset in px and degrees, movement error, and force.

The white arrow is hidden below magnitude 0.25 to avoid enlarging numerical dust; the readout still reports the exact value. Arrow lengths use a square-root scale.

## Read the chamber

- Thin cyan line: finite **14-second forecast**, refreshed every 0.6 s of real time (its simulation-time interval stretches with the speed slider).
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

`experiments/guidance-probe.js` reports loop detection and compares phase recurrence with guidance disabled and enabled. `experiments/edit-continuity.js` measures how far a magnet or reflector nudge moves the rail and the beam (the transport keeps both proportional to the edit), that a large edit still re-derives the rail, and that a drag keeps the beam inside the pull tolerance. `experiments/ui-wiring.js` loads the page against a minimal DOM stub and drives the transport controls, standing in for the Playwright smoke test where no browser binary exists. `experiments/loop-sweep.js` sweeps guide strength against pull tolerance; `experiments/validate-tuned.js` checks the tuned defaults over long runs, determinism, and magnet perturbation recovery (one-shot edit, reported per phase window), plus a large-edit boundary probe. `experiments/preset-search.js` searches UI-reachable magnet and reflector layouts for a known-stable preset: it evaluates a layout by the *worst* deviation over a long horizon (locked orbits on searched fields can swing duties in a slow limit cycle, so a snapshot is misleading), scores rail churn and ride wander, resumes from earlier search logs, rounds candidates to ship granularity, and confirms survivors at full fidelity. Its rounds are recorded under `experiments/logs/`. `experiments/browser-smoke.js` is an optional Playwright smoke test; install Playwright outside the runtime tree and optionally supply `BROWSER_EXECUTABLE`.

## Prototype boundaries / next work

Scenario solvability is not yet proven: six preset-search rounds (`experiments/logs/preset-search*.json`) have found no layout that holds all three targets inside ±30% for 8 s; the best still reaches a 41% worst deviation (see `archive/0.1.10-worklog.md`). The loop-lock guide holds the default orbit firmly (recurrence median ~0.4 px over two minutes, ~99% of the time locked to a lap), but that orbit feeds only target B; layouts that also reach A and C inside the ±30% band have not been found. A measured obstacle, recorded in `experiments/logs/`: on searched layouts the locked orbit's target duties swing in a slow limit cycle (±40%, 60–120 s period, undamped over 10 minutes), so the 8-second streak keeps resetting. Guide-level remedies were measured and rejected — stiffer gains, a higher force cap, and letting the rail roll with the beam all leave the swing unchanged or make it worse (rolling removes the ride wander, 21 → 4 px, yet the duty swing grows, 46% → 82%, which shows the swing is the lap geometry itself, not tracking error). Guide strength remains gameplay tuning rather than a physical constant. The next step is a preset search that selects for stationary lap geometry — the tooling in `experiments/preset-search.js` is ready for it — followed by playtesting across magnet edits, target duties, and cooling exposure. Magnet and reflector edits now transport the held rail, so the orbit tracks an edit instead of jumping to another lap; a large edit that moves the orbit beyond the pull tolerance still re-derives it, and after such an edit the beam rides the transported lap a little looser than a freshly searched one (measured: recurrence ~8 px versus ~1 px, still locked and bounded).

Dwell is integrated along each sampled line segment using timestamp intervals. The live path uses 120 Hz steps; the forecast stores 40 Hz samples. Curvature and within-step reflector kinks are therefore approximated by chords.
