# Findings and pitfalls

- Keep forecast and live simulation buffers separate. Forecasting must copy the particle into reusable scratch state and must not accumulate live activation or advance the live clock.
- A nearest point on the immediate continuation is mathematically correct but useless for loop formation. Exclude enough near future that selection can reach a return pass.
- At trajectory crossings, nearest position alone can choose an opposing branch or a branch with very different speed. Store movement vectors and select in phase space: position plus velocity error. Reject perpendicular and opposing states before scoring.
- Use the selected point consistently. The green ring, target movement arrow, readout, and controller must all come from the same interpolated segment state and current simulation instant.
- Position-only pursuit can arrive with the wrong heading and cross the path again. A damped controller needs both position error and target-minus-current velocity error to join a repeatable loop.
- A full state controller is not constrained to be lateral: braking or acceleration can be the correct way to match target speed. Prevent harmful forces by selecting a compatible target and bounding/fading authority, not by deleting the along-velocity component.
- A temporal dead zone needs a fade. Strictly skipping two seconds and immediately applying full force creates target handoff impulses; a one-second smoothstep gives return candidates gradual authority.
- Search only future timestamps for loop closure. Past trajectory points behave like a history rail after player edits and let the just-traversed outgoing branch compete with the intended next return branch.
- Forecast and guidance form an implicit feedback problem. Two reusable forecast passes provide a current proposal without introducing allocations or a long-lived committed route.
- Draw current movement, target movement, and applied force as separate vectors. A force arrow alone cannot explain whether the chosen trajectory branch has the right phase state.
- Debug arrows must be scaled honestly. A forced minimum length makes numerical dust look like a real pull; use a compressive scale, a visibility threshold, and an exact numeric readout.
- Target influence is dwell time, not entry count. Segment-circle overlap multiplied by timestamp differences makes forecasting less sensitive to sample spacing.
- Preserve classic script loading and guarded CommonJS exports so the same core runs under `file://` and Node tests without a build.
- Keep browser tooling external to the runtime tree. The optional Playwright experiment accepts `BROWSER_EXECUTABLE` for environments where automatic browser downloads are unavailable.
