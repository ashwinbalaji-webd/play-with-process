# play-with-process

Minimal FastAPI playground for learning how process scheduling, CPU affinity, niceness, context switching, and memory allocation feel on a real machine.

## Stack

- Python 3.11+
- FastAPI
- `psutil`
- TailwindCSS via CDN
- Vanilla JavaScript

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 main.py
```

Open `http://127.0.0.1:8000`.

## What This App Can Do

- Spawn `LOW`, `MEDIUM`, or `HIGH` worker processes
- Increment or decrement worker threads inside a process
- Pin a process to specific CPU cores when the OS supports affinity
- Change process niceness with a playful `Selfishness` slider
- Show process status plus voluntary and involuntary context switches per second
- Inflate or deflate a process memory balloon
- Launch a temporary `Chaos Monkey` to add outside load on one core
- Stream machine and worker telemetry over `/ws/metrics`

## Read The Graphs Correctly

This is the most important section in the whole project.

### 1. The per-core bars are system-wide

The per-core CPU grid is the whole machine view, not the selected worker view.

That means the bars include:

- your browser
- the FastAPI server
- the OS
- background apps
- your spawned workers

So if one worker is pinned to `core 7`, it does **not** mean every other core should become `0%`.

### 2. One busy thread usually means about one logical CPU of total work

If you spawn:

- `HIGH`
- `1 thread`
- `all cores allowed`

you should usually expect roughly:

- process CPU near `100%`
- core equivalent near `1.0`
- one hot core at a time

What may move around is **which** allowed core is hot during a sample.

That is the scheduler migrating the runnable thread across eligible cores.

### 3. `PID CPU`, `Current CPU`, and affinity answer different questions

- `PID CPU`: how much CPU this process consumed
- `Current CPU`: where the kernel sampled it right now
- `Affinity`: which CPUs the process is allowed to run on

You need all three together to reason clearly.

## Why Your Single HIGH Worker Looked "Random"

You described two cases:

### Case A: `HIGH` + `1 thread` + all cores selected

Why the hotspot moves:

- a single hot Python thread can consume about one logical CPU in total
- when many cores are allowed, the OS can move that thread between eligible CPUs
- the per-core chart is sampled over time, so the heat can appear on core `1`, then `5`, then `7`

What to notice:

- the **worker's** CPU should stay around one full logical CPU
- the **hot core** can migrate
- that does not mean the process is using all cores equally at once

### Case B: `HIGH` + `1 thread` + pinned to one core

If you pin a worker to `core 7`, then ideally that worker should run only on that allowed CPU.

But you may still see activity on other cores because:

- the per-core chart is still system-wide
- your browser and backend are unpinned
- the OS is doing its own work
- short sampling windows can make unrelated core activity look dramatic

What to compare instead:

- worker `PID CPU`
- worker `Current CPU`
- worker `Affinity`
- the selected core bar

That combination is much more reliable than looking only at the full machine core grid.

## Task Profiles

### LOW

- Uses math loops plus deliberate sleeping
- Usually bursty
- Voluntary context switches should rise

### MEDIUM

- Uses hashing bursts with brief pauses
- More stable than `LOW`
- Still yields often enough to show cooperative behavior

### HIGH

- Uses a tight busy loop
- Best for studying migration, preemption, and affinity

## New Educational Features

### 1. Selfishness Slider (Niceness)

The slider controls process niceness:

- lower nice value = more selfish = more favorable scheduling
- higher nice value = more polite = lower priority under contention

What to notice:

- niceness is easiest to see when **two busy workers compete on the same core**
- if both run on different cores, priority often matters much less

Practical note:

- lowering niceness below the current value may require elevated privileges
- positive niceness values usually work as an ordinary user

### 2. Context Switches and Status

Each worker card shows:

- process status
- voluntary context switches per second
- involuntary context switches per second

Mental model:

- higher **voluntary** switches usually means the process is sleeping or yielding
- higher **involuntary** switches usually means the kernel is preempting it because other runnable work is competing

Important note:

- `status` is an instant sample, not a whole-interval summary, so a hot worker can briefly show `sleeping` between time slices and still have high CPU over the last sample window

### 3. Memory Balloon

Each worker can manually allocate extra memory.

This build intentionally **touches** the allocated pages, so you should usually see:

- `RSS` rise
- `VMS` rise too

Definitions:

- `RSS` = resident set size = physical memory currently in RAM for the process
- `VMS` = virtual memory size = the process virtual address space reservation

Because this build touches the pages immediately, RSS is the most obvious signal during the experiment.

### 4. Chaos Monkey

The `Chaos Monkey` spawns a temporary external hog pinned to one core.

Use it to study:

- how unpinned workers migrate away from a stressed core
- how pinned workers cannot escape
- how involuntary context switches rise when multiple busy workers fight for the same CPU

## Suggested Experiments

### Experiment 1: Understand migration

1. Spawn one `HIGH` worker with `1` thread.
2. Leave affinity on `All Cores`.
3. Watch `PID CPU`, `Current CPU`, and the per-core grid.

What to notice:

- `PID CPU` stays near one full core
- the hot core changes over time
- `Current CPU` follows that movement

### Experiment 2: Understand pinning

1. Keep one `HIGH` worker with `1` thread.
2. Pin it to a single core.
3. Compare the chosen core with the worker card.

What to notice:

- the worker should keep reporting the pinned core as its allowed CPU
- the selected core should carry most of that worker's heat
- other cores can still show unrelated system load

### Experiment 3: Make niceness visible

1. Spawn two `HIGH` workers.
2. Pin both to the same single core.
3. Set one worker to a more polite nice value like `10`.
4. Keep the other near `0` or make it more selfish if your permissions allow it.

What to notice:

- the more selfish worker should win more CPU time
- the more polite worker should lose more CPU time
- involuntary context switches should rise because both are runnable on one core

### Experiment 4: Compare LOW vs HIGH switching behavior

1. Spawn one `LOW` worker.
2. Spawn one `HIGH` worker.
3. Let both run unpinned.

What to notice:

- `LOW` should show more voluntary switching
- `HIGH` should spend more time running hot
- the cards should feel behaviorally different even before you look at raw CPU numbers

### Experiment 5: Study memory growth

1. Spawn any worker.
2. Press `+32 MB` a few times.
3. Watch `RSS`, `VMS`, and the balloon counter.
4. Press `Release All`.

What to notice:

- `RSS` should climb because pages are touched
- `VMS` should also climb
- freeing memory should reduce the balloon count and often reduce RSS, though allocator behavior can be a bit sticky

### Experiment 6: Force migration with Chaos Monkey

1. Spawn one `HIGH` worker with `All Cores`.
2. Launch `Chaos Monkey` on one core.
3. Watch `Current CPU` for the worker.

What to notice:

- the unpinned worker may migrate away from the stressed core
- if you pin the worker to that same core, it can no longer escape

## API Overview

### Worker control

- `POST /api/process/spawn`
- `POST /api/process/{pid}/threads/increment`
- `POST /api/process/{pid}/threads/decrement`
- `POST /api/process/{pid}/affinity`
- `POST /api/process/{pid}/priority`
- `POST /api/process/{pid}/memory/inflate`
- `POST /api/process/{pid}/memory/deflate`
- `DELETE /api/process/{pid}`
- `DELETE /api/processes`

### Chaos

- `POST /api/chaos/spawn`

### Streaming

- `GET /api/processes`
- `GET /api/health`
- `WS /ws/metrics`

## Notes And Limits

- CPU affinity is broadly available on Linux. `psutil` does not expose it on macOS, so affinity-based features are disabled there.
- `Current CPU` is also platform dependent. If the OS does not expose it, the card shows `-`.
- Niceness is platform dependent and permission dependent. As a normal user, becoming more polite is usually easier than becoming more selfish.
- The memory balloon is capped to keep the lab from becoming too destructive.
- Standard Python threads are still subject to the GIL. This playground is meant to teach scheduling intuition, not to be a perfect hardware benchmark.
