const state = {
  socket: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  snapshot: null,
  intervalMs: 1000,
};

const elements = {
  connectionIndicator: document.getElementById("connection-indicator"),
  connectionLabel: document.getElementById("connection-label"),
  lastUpdated: document.getElementById("last-updated"),
  initialThreads: document.getElementById("initial-threads"),
  refreshInterval: document.getElementById("refresh-interval"),
  killAll: document.getElementById("kill-all"),
  spawnChaos: document.getElementById("spawn-chaos"),
  chaosCore: document.getElementById("chaos-core"),
  chaosDuration: document.getElementById("chaos-duration"),
  affinityNote: document.getElementById("affinity-note"),
  summaryGlobalCpu: document.getElementById("summary-global-cpu"),
  summaryMemory: document.getElementById("summary-memory"),
  summaryProcesses: document.getElementById("summary-processes"),
  summaryChaos: document.getElementById("summary-chaos"),
  summaryThreads: document.getElementById("summary-threads"),
  coreCount: document.getElementById("core-count"),
  coreGrid: document.getElementById("core-grid"),
  chaosGrid: document.getElementById("chaos-grid"),
  processGrid: document.getElementById("process-grid"),
  toastStack: document.getElementById("toast-stack"),
};

function setConnectionState(kind, label) {
  const palette = {
    connecting: ["bg-amber-300", "Connecting"],
    live: ["bg-emerald-300", label || "Live"],
    offline: ["bg-rose-300", label || "Reconnecting"],
  };
  const [indicatorClass, text] = palette[kind] || palette.connecting;
  elements.connectionIndicator.className = `h-3 w-3 rounded-full ${indicatorClass}`;
  elements.connectionLabel.textContent = text;
}

function formatPercent(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatMemory(value) {
  return `${Number(value || 0).toFixed(1)} MB`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatUptime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s alive`;
  }
  return `${minutes}m ${remainingSeconds}s alive`;
}

function formatRemaining(autoStopAt) {
  if (!autoStopAt) {
    return "manual";
  }
  const remaining = Math.max(0, Math.ceil(autoStopAt - Date.now() / 1000));
  return `${remaining}s left`;
}

function humanizeStatus(status) {
  const text = String(status || "unknown").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function taskTone(taskType) {
  return {
    LOW: "border-emerald-300/20 bg-emerald-300/10 text-emerald-100",
    MEDIUM: "border-cyan-300/20 bg-cyan-300/10 text-cyan-100",
    HIGH: "border-rose-300/20 bg-rose-300/10 text-rose-100",
  }[taskType] || "border-white/10 bg-white/5 text-slate-100";
}

function statusTone(status) {
  if (status === "running") {
    return "border-emerald-300/20 bg-emerald-300/10 text-emerald-100";
  }
  if (status === "sleeping") {
    return "border-amber-300/20 bg-amber-300/10 text-amber-50";
  }
  return "border-white/10 bg-white/5 text-slate-200";
}

function toastTone(tone) {
  return {
    success: "border-emerald-300/25 bg-emerald-300/12 text-emerald-50",
    error: "border-rose-300/25 bg-rose-300/12 text-rose-50",
    info: "border-cyan-300/25 bg-cyan-300/12 text-cyan-50",
  }[tone] || "border-white/10 bg-white/10 text-white";
}

function showToast(message, tone = "info") {
  const toast = document.createElement("div");
  toast.className = `${toastTone(tone)} rounded-3xl border px-4 py-3 text-sm shadow-2xl backdrop-blur`;
  toast.innerHTML = `
    <div class="font-mono text-[11px] uppercase tracking-[0.25em] opacity-70">${tone}</div>
    <div class="mt-1 leading-6">${message}</div>
  `;
  elements.toastStack.appendChild(toast);

  window.setTimeout(() => {
    toast.classList.add("opacity-0", "translate-y-2", "transition", "duration-300");
  }, 3400);

  window.setTimeout(() => {
    toast.remove();
  }, 3800);
}

function splitProcesses(snapshot) {
  const processes = snapshot?.processes || [];
  return {
    chaos: processes.filter((process) => process.worker_kind === "CHAOS"),
    playground: processes.filter((process) => process.worker_kind !== "CHAOS"),
  };
}

function getProcessByPid(pid) {
  return state.snapshot?.processes?.find((process) => process.pid === Number(pid));
}

function api(path, options = {}) {
  return fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (response) => {
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : {};
    if (!response.ok) {
      throw new Error(payload.detail || "Request failed.");
    }
    return payload;
  });
}

async function refreshSnapshot() {
  try {
    const snapshot = await api("/api/processes", { method: "GET" });
    state.snapshot = snapshot;
    render(snapshot);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function niceToSelfishness(niceValue) {
  return 19 - Number(niceValue ?? 0);
}

function selfishnessToNice(value) {
  return 19 - Number(value);
}

function selfishnessLabel(niceValue) {
  if (niceValue <= -10) {
    return "very selfish";
  }
  if (niceValue < 0) {
    return "selfish";
  }
  if (niceValue === 0) {
    return "balanced";
  }
  if (niceValue < 10) {
    return "polite";
  }
  return "very polite";
}

function noteForSpawn(taskType) {
  if (taskType === "HIGH") {
    return "Notice: one HIGH thread usually means about one logical CPU of total work, so expect one hotspot that can migrate between allowed cores.";
  }
  if (taskType === "MEDIUM") {
    return "Notice: MEDIUM alternates work and short breathers, so CPU looks steadier than LOW but less absolute than HIGH.";
  }
  return "Notice: LOW intentionally sleeps, so voluntary context switches should rise and the core bars should look bursty.";
}

function noteForAffinity(process, cores) {
  if (!cores.length) {
    return "Notice: all eligible cores are available again, so the scheduler is free to move this worker between them.";
  }
  return `Notice: compare the selected core(s) with PID CPU and Current CPU. The per-core chart is system-wide, so other cores can stay busy for unrelated reasons.`;
}

function noteForPriority(niceValue) {
  if (niceValue < 0) {
    return "Notice: this worker is now more selfish. On a shared core it should win more CPU time if the OS accepted the lower niceness.";
  }
  if (niceValue > 0) {
    return "Notice: this worker is now more polite. When it competes on a shared core, expect it to lose more time to selfish neighbors.";
  }
  return "Notice: niceness is back at the default balance. Compare it against another worker on the same core for the clearest effect.";
}

function noteForMemory(direction) {
  if (direction === "inflate") {
    return "Notice: RSS should climb because this build touches the new pages immediately. VMS is the broader address-space reservation.";
  }
  return "Notice: freed balloon memory should reduce RSS, though allocators and the OS may release some memory lazily.";
}

function noteForChaos(core) {
  return `Notice: unpinned workers may migrate away from core ${core}. Pinned workers on that core cannot escape and should show more involuntary preemption.`;
}

function syncCoreSelect(availableCores) {
  const currentOptions = [...elements.chaosCore.options].map((option) => Number(option.value));
  const same =
    currentOptions.length === availableCores.length &&
    currentOptions.every((value, index) => value === availableCores[index]);

  if (same) {
    return;
  }

  elements.chaosCore.innerHTML = availableCores
    .map((core) => `<option value="${core}">Core ${core}</option>`)
    .join("");
}

function renderCoreGrid(snapshot, chaosProcesses, allProcesses) {
  const perCore = snapshot.system.per_core_cpu || [];
  const chaosTargets = new Set(
    chaosProcesses.flatMap((process) => (process.affinity.length ? [process.affinity[0]] : []))
  );
  const sampledWorkers = allProcesses.reduce((counts, process) => {
    if (Number.isInteger(process.current_cpu)) {
      counts[process.current_cpu] = (counts[process.current_cpu] || 0) + 1;
    }
    return counts;
  }, {});

  elements.coreCount.textContent = `${perCore.length} cores`;
  syncCoreSelect(snapshot.meta.available_cores || []);

  elements.coreGrid.innerHTML = perCore
    .map((usage, index) => {
      const tags = [];
      if (chaosTargets.has(index)) {
        tags.push(
          `<span class="rounded-full border border-amber-300/25 bg-amber-300/12 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-amber-50">chaos</span>`
        );
      }
      if (sampledWorkers[index]) {
        tags.push(
          `<span class="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-slate-300">${sampledWorkers[index]} sampled</span>`
        );
      }

      return `
        <div class="rounded-3xl border border-white/10 bg-slate-950/45 p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <span class="font-mono uppercase tracking-[0.2em] text-slate-400">Core ${index}</span>
              <div class="mt-2 flex flex-wrap gap-2">${tags.join("")}</div>
            </div>
            <span class="text-lg font-semibold text-slate-100">${formatPercent(usage)}</span>
          </div>
          <div class="mt-3 h-3 overflow-hidden rounded-full bg-white/5">
            <div
              class="h-full rounded-full bg-gradient-to-r from-cyan-300 via-sky-300 to-lime-300 transition-all duration-500"
              style="width: ${Math.min(100, usage)}%"
            ></div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderAffinityButtons(process, availableCores) {
  if (!process.affinity_supported) {
    return `
      <p class="text-sm leading-6 text-slate-400">
        This platform does not expose CPU affinity through <span class="font-mono">psutil</span>,
        so pinning is disabled.
      </p>
    `;
  }

  return `
    <div class="flex flex-wrap gap-2">
      <button
        data-action="reset-affinity"
        data-pid="${process.pid}"
        class="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-200 transition hover:border-cyan-300/25 hover:bg-cyan-300/10"
      >
        All Cores
      </button>
      ${availableCores
        .map((core) => {
          const selected = process.affinity.includes(core);
          return `
            <button
              data-action="toggle-affinity"
              data-pid="${process.pid}"
              data-core="${core}"
              class="rounded-full border px-3 py-1 text-xs transition ${
                selected
                  ? "border-cyan-300/35 bg-cyan-300/14 text-cyan-50"
                  : "border-white/10 bg-white/5 text-slate-200 hover:border-cyan-300/25 hover:bg-cyan-300/10"
              }"
            >
              Core ${core}
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderHints(process) {
  const hints = process.observation_hints || [];
  if (!hints.length) {
    return `<p class="text-sm text-slate-300">No special hint right now. Try changing affinity or niceness to surface a stronger scheduling signal.</p>`;
  }
  return `
    <ul class="space-y-2 text-sm leading-6 text-slate-300">
      ${hints.map((hint) => `<li>${hint}</li>`).join("")}
    </ul>
  `;
}

function renderChaosGrid(chaosProcesses) {
  if (!chaosProcesses.length) {
    elements.chaosGrid.innerHTML = `
      <div class="rounded-[1.75rem] border border-dashed border-white/10 bg-slate-950/35 p-8 text-center text-slate-300 xl:col-span-2">
        <p class="font-mono text-xs uppercase tracking-[0.3em] text-slate-500">No External Pressure</p>
        <p class="mt-3 leading-7 text-slate-400">
          Launch the Chaos Monkey to pin a temporary outside hog to one core and watch unpinned workers react.
        </p>
      </div>
    `;
    return;
  }

  elements.chaosGrid.innerHTML = chaosProcesses
    .map(
      (process) => `
        <article class="rounded-[1.75rem] border border-amber-300/12 bg-slate-950/40 p-5 shadow-2xl">
          <div class="flex items-start justify-between gap-4">
            <div>
              <span class="rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-1 text-xs font-medium text-amber-50">
                Chaos
              </span>
              <h3 class="mt-4 text-2xl font-semibold">${process.name}</h3>
              <p class="mt-2 font-mono text-xs text-slate-400">
                PID ${process.pid} • ${formatRemaining(process.auto_stop_at)}
              </p>
            </div>
            <button
              data-action="kill"
              data-pid="${process.pid}"
              class="rounded-2xl border border-rose-300/25 bg-rose-300/10 px-4 py-2 text-sm font-medium text-rose-100 transition hover:border-rose-200/40 hover:bg-rose-300/16"
            >
              Stop
            </button>
          </div>

          <div class="mt-5 grid gap-3 sm:grid-cols-3">
            <div class="rounded-3xl border border-white/8 bg-white/[0.03] p-4">
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">CPU</p>
              <p class="mt-3 text-2xl font-bold">${formatPercent(process.cpu_percent)}</p>
            </div>
            <div class="rounded-3xl border border-white/8 bg-white/[0.03] p-4">
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Pinned Core</p>
              <p class="mt-3 text-2xl font-bold">${process.affinity[0] ?? "-"}</p>
            </div>
            <div class="rounded-3xl border border-white/8 bg-white/[0.03] p-4">
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Current CPU</p>
              <p class="mt-3 text-2xl font-bold">${process.current_cpu ?? "-"}</p>
            </div>
          </div>

          <div class="mt-5 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
            <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">What To Notice</p>
            <div class="mt-3">${renderHints(process)}</div>
          </div>
        </article>
      `
    )
    .join("");
}

function renderProcessGrid(processes, availableCores) {
  if (!processes.length) {
    elements.processGrid.innerHTML = `
      <div class="rounded-[1.75rem] border border-dashed border-white/10 bg-slate-950/35 p-10 text-center text-slate-300 xl:col-span-2">
        <p class="font-mono text-xs uppercase tracking-[0.3em] text-slate-500">No Workers Yet</p>
        <h3 class="mt-3 text-2xl font-semibold text-slate-100">Spawn a load profile to begin.</h3>
        <p class="mt-3 max-w-xl mx-auto leading-7 text-slate-400">
          Start with one HIGH thread if you want to study core migration, or one LOW worker if
          you want to see voluntary sleeping and bursty context switching.
        </p>
      </div>
    `;
    return;
  }

  elements.processGrid.innerHTML = processes
    .map((process) => {
      const niceValue = Number.isInteger(process.nice_value) ? process.nice_value : 0;
      const selfishness = niceToSelfishness(niceValue);
      return `
        <article class="rounded-[1.75rem] border border-white/10 bg-slate-950/40 p-5 shadow-2xl">
          <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div class="flex flex-wrap items-center gap-3">
                <span class="rounded-full border px-3 py-1 text-xs font-medium ${taskTone(process.task_type)}">
                  ${process.task_type}
                </span>
                <span class="rounded-full border px-3 py-1 text-xs ${statusTone(process.status)}">
                  ${humanizeStatus(process.status)}
                </span>
              </div>
              <h3 class="mt-4 text-2xl font-semibold">${process.name}</h3>
              <p class="mt-2 font-mono text-xs text-slate-400">
                PID ${process.pid} • ${formatUptime(process.uptime_seconds)}
              </p>
            </div>

            <button
              data-action="kill"
              data-pid="${process.pid}"
              class="rounded-2xl border border-rose-300/25 bg-rose-300/10 px-4 py-2 text-sm font-medium text-rose-100 transition hover:border-rose-200/40 hover:bg-rose-300/16"
            >
              Kill
            </button>
          </div>

          <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div class="min-w-0 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">PID CPU</p>
              <p class="mt-3 break-words text-xl font-bold leading-tight xl:text-2xl">${formatPercent(process.cpu_percent)}</p>
            </div>
            <div class="min-w-0 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Core Eq.</p>
              <p class="mt-3 break-words text-xl font-bold leading-tight xl:text-2xl">${Number(process.core_equivalent || 0).toFixed(2)}</p>
            </div>
            <div class="min-w-0 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Current CPU</p>
              <p class="mt-3 break-words text-xl font-bold leading-tight xl:text-2xl">${process.current_cpu ?? "-"}</p>
            </div>
            <div class="min-w-0 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">RSS</p>
              <p class="mt-3 break-words text-xl font-bold leading-tight xl:text-2xl">${formatMemory(process.rss_mb)}</p>
            </div>
            <div class="min-w-0 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">VMS</p>
              <p class="mt-3 break-words text-xl font-bold leading-tight xl:text-2xl">${formatMemory(process.vms_mb)}</p>
            </div>
            <div class="min-w-0 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Threads</p>
              <p class="mt-3 break-words text-xl font-bold leading-tight xl:text-2xl">${process.thread_count}</p>
            </div>
          </div>

          <div class="mt-5 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
            <div class="flex flex-col gap-4">
              <div>
                <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Scheduler Lab</p>
                <p class="mt-2 text-sm leading-6 text-slate-300">
                  Selfishness is just a playful wrapper around OS niceness. Lower nice means more selfish, and status is only an instant snapshot.
                </p>
              </div>
              <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div class="min-w-0 rounded-2xl border border-white/8 bg-slate-950/45 px-3 py-2 text-sm text-slate-200">
                  <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Status</span>
                  <div class="mt-1 break-words leading-tight">${humanizeStatus(process.status)}</div>
                </div>
                <div class="min-w-0 rounded-2xl border border-white/8 bg-slate-950/45 px-3 py-2 text-sm text-slate-200">
                  <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Nice</span>
                  <div class="mt-1 break-words leading-tight">${process.nice_value ?? "-"}</div>
                </div>
                <div class="min-w-0 rounded-2xl border border-white/8 bg-slate-950/45 px-3 py-2 text-sm text-slate-200">
                  <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Vol ctx/s</span>
                  <div class="mt-1 break-words leading-tight">${Number(process.context_switches.voluntary_per_sec || 0).toFixed(1)}</div>
                </div>
                <div class="min-w-0 rounded-2xl border border-white/8 bg-slate-950/45 px-3 py-2 text-sm text-slate-200">
                  <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Inv ctx/s</span>
                  <div class="mt-1 break-words leading-tight">${Number(process.context_switches.involuntary_per_sec || 0).toFixed(1)}</div>
                </div>
              </div>
            </div>

            <div class="mt-4 rounded-3xl border border-white/8 bg-slate-950/45 p-4">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Selfishness Slider</p>
                  <p
                    class="mt-2 text-sm text-slate-300"
                    data-nice-preview="${process.pid}"
                  >
                    nice ${niceValue} • ${selfishnessLabel(niceValue)}
                  </p>
                </div>
                <div class="text-right text-xs text-slate-400">
                  <div>polite</div>
                  <div class="mt-1">selfish</div>
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="39"
                value="${selfishness}"
                data-action="nice-slider"
                data-pid="${process.pid}"
                class="mt-4 w-full accent-cyan-300"
              />
            </div>
          </div>

          <div class="mt-5 flex flex-col gap-3 rounded-3xl border border-white/8 bg-white/[0.03] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Scale Threads</p>
              <p class="mt-2 text-sm text-slate-300">
                Raise or lower active worker threads without recreating the process.
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button
                data-action="decrement"
                data-pid="${process.pid}"
                class="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-lg font-semibold text-slate-100 transition hover:border-cyan-300/25 hover:bg-cyan-300/10"
              >
                -
              </button>
              <button
                data-action="increment"
                data-pid="${process.pid}"
                class="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-lg font-semibold text-cyan-50 transition hover:border-cyan-200/35 hover:bg-cyan-300/16"
              >
                +
              </button>
            </div>
          </div>

          <div class="mt-5 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
            <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Memory Balloon</p>
                <p class="mt-2 text-sm leading-6 text-slate-300">
                  This build touches balloon pages immediately so RSS climbs with the manual allocation.
                </p>
              </div>
              <div class="rounded-2xl border border-white/8 bg-slate-950/45 px-4 py-3 text-sm text-slate-200">
                <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Balloon</span>
                <div class="mt-1">${process.balloon_mb} MB</div>
              </div>
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              <button
                data-action="inflate-memory"
                data-pid="${process.pid}"
                data-mb="32"
                class="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-sm text-cyan-50 transition hover:border-cyan-200/35 hover:bg-cyan-300/16"
              >
                +32 MB
              </button>
              <button
                data-action="inflate-memory"
                data-pid="${process.pid}"
                data-mb="128"
                class="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-sm text-cyan-50 transition hover:border-cyan-200/35 hover:bg-cyan-300/16"
              >
                +128 MB
              </button>
              <button
                data-action="deflate-memory"
                data-pid="${process.pid}"
                data-mb="32"
                class="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-100 transition hover:border-cyan-300/25 hover:bg-cyan-300/10"
              >
                -32 MB
              </button>
              <button
                data-action="release-memory"
                data-pid="${process.pid}"
                data-mb="${process.balloon_mb}"
                class="rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-100 transition hover:border-cyan-300/25 hover:bg-cyan-300/10"
              >
                Release All
              </button>
            </div>
          </div>

          <div class="mt-5 rounded-3xl border border-white/8 bg-white/[0.03] p-4">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p class="font-mono text-xs uppercase tracking-[0.25em] text-slate-500">Affinity</p>
                <p class="mt-2 text-sm text-slate-300">
                  Current selection:
                  <span class="font-mono text-slate-100">${
                    process.affinity.length ? `[${process.affinity.join(", ")}]` : "Unavailable"
                  }</span>
                </p>
              </div>
            </div>
            <div class="mt-4">
              ${renderAffinityButtons(process, availableCores)}
            </div>
          </div>

          <div class="mt-5 rounded-3xl border border-lime-300/12 bg-lime-300/[0.05] p-4">
            <p class="font-mono text-xs uppercase tracking-[0.25em] text-lime-100/80">What To Notice</p>
            <div class="mt-3">${renderHints(process)}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function render(snapshot) {
  const { chaos, playground } = splitProcesses(snapshot);
  const allProcesses = snapshot.processes || [];
  const totalThreads = allProcesses.reduce((sum, process) => sum + process.thread_count, 0);

  elements.summaryGlobalCpu.textContent = formatPercent(snapshot.system.global_cpu);
  elements.summaryMemory.textContent = formatPercent(snapshot.system.memory_percent);
  elements.summaryProcesses.textContent = String(playground.length);
  elements.summaryChaos.textContent = String(chaos.length);
  elements.summaryThreads.textContent = String(totalThreads);
  elements.lastUpdated.textContent = `Last update ${formatTime(snapshot.meta.timestamp)}`;
  elements.affinityNote.textContent = snapshot.meta.affinity_supported
    ? "Affinity control is available. If a worker is pinned to one core, compare that core with the worker's Current CPU and PID CPU before drawing conclusions."
    : "Affinity control is disabled on this platform, but niceness, context switching, and memory experiments still work.";

  renderCoreGrid(snapshot, chaos, allProcesses);
  renderChaosGrid(chaos);
  renderProcessGrid(playground, snapshot.meta.available_cores || []);
}

function scheduleReconnect() {
  window.clearTimeout(state.reconnectTimer);
  const delay = Math.min(4000, 700 + state.reconnectAttempts * 500);
  state.reconnectAttempts += 1;
  state.reconnectTimer = window.setTimeout(connectSocket, delay);
}

function connectSocket() {
  window.clearTimeout(state.reconnectTimer);

  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
  }

  setConnectionState("connecting");

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${protocol}://${window.location.host}/ws/metrics?interval_ms=${state.intervalMs}`;
  const socket = new WebSocket(url);
  state.socket = socket;

  socket.onopen = () => {
    state.reconnectAttempts = 0;
    setConnectionState("live", "Streaming");
  };

  socket.onmessage = (event) => {
    const snapshot = JSON.parse(event.data);
    state.snapshot = snapshot;
    render(snapshot);
  };

  socket.onerror = () => {
    socket.close();
  };

  socket.onclose = () => {
    if (state.socket !== socket) {
      return;
    }
    setConnectionState("offline", "Reconnecting");
    scheduleReconnect();
  };
}

async function spawnProcess(taskType) {
  const initialThreads = Number(elements.initialThreads.value || 1);
  if (initialThreads < 1 || initialThreads > 16) {
    showToast("Initial threads must stay between 1 and 16.", "error");
    return;
  }

  try {
    const payload = await api("/api/process/spawn", {
      method: "POST",
      body: JSON.stringify({ task_type: taskType, initial_threads: initialThreads }),
    });
    showToast(`Spawned ${payload.process.name}. ${noteForSpawn(taskType)}`, "success");
    refreshSnapshot();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function spawnChaos() {
  const core = Number(elements.chaosCore.value);
  const durationSeconds = Number(elements.chaosDuration.value);

  try {
    await api("/api/chaos/spawn", {
      method: "POST",
      body: JSON.stringify({ core, duration_seconds: durationSeconds }),
    });
    showToast(`Chaos Monkey launched on core ${core}. ${noteForChaos(core)}`, "success");
    refreshSnapshot();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function updateThreads(pid, direction) {
  try {
    const payload = await api(`/api/process/${pid}/threads/${direction}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    showToast(`PID ${pid} now has ${payload.thread_count} thread(s). Notice: more threads can push total PID CPU above one core when the workload truly runs in parallel.`, "success");
    refreshSnapshot();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function killProcess(pid) {
  try {
    await api(`/api/process/${pid}`, { method: "DELETE" });
    showToast(`PID ${pid} terminated.`, "success");
    refreshSnapshot();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function killAllProcesses() {
  try {
    const payload = await api("/api/processes", { method: "DELETE" });
    showToast(`Stopped ${payload.terminated} process(es).`, "success");
    refreshSnapshot();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function setAffinity(pid, cores) {
  const process = getProcessByPid(pid);
  try {
    await api(`/api/process/${pid}/affinity`, {
      method: "POST",
      body: JSON.stringify({ cores }),
    });
    showToast(`Updated affinity for PID ${pid}. ${noteForAffinity(process, cores)}`, "success");
    refreshSnapshot();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function setPriority(pid, niceValue) {
  try {
    await api(`/api/process/${pid}/priority`, {
      method: "POST",
      body: JSON.stringify({ nice_value: niceValue }),
    });
    showToast(`Set PID ${pid} to nice ${niceValue}. ${noteForPriority(niceValue)}`, "success");
    refreshSnapshot();
  } catch (error) {
    showToast(error.message, "error");
    refreshSnapshot();
  }
}

async function changeMemory(pid, direction, mb) {
  if (mb <= 0) {
    showToast("There is no balloon memory to release yet.", "info");
    return;
  }

  try {
    const payload = await api(`/api/process/${pid}/memory/${direction}`, {
      method: "POST",
      body: JSON.stringify({ mb }),
    });
    showToast(
      `PID ${pid} balloon is now ${payload.balloon_mb} MB. ${noteForMemory(direction)}`,
      "success"
    );
    refreshSnapshot();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function toggleAffinity(pid, core) {
  const process = getProcessByPid(pid);
  if (!process || !process.affinity_supported) {
    return;
  }

  const selected = new Set(process.affinity);
  const numericCore = Number(core);

  if (selected.has(numericCore)) {
    if (selected.size === 1) {
      showToast("At least one core should stay selected. Use All Cores to release the pin.", "info");
      return;
    }
    selected.delete(numericCore);
  } else {
    selected.add(numericCore);
  }

  const cores = [...selected].sort((left, right) => left - right);
  await setAffinity(pid, cores);
}

function updateNicePreview(input) {
  const pid = Number(input.dataset.pid);
  const niceValue = selfishnessToNice(input.value);
  const target = document.querySelector(`[data-nice-preview="${pid}"]`);
  if (!target) {
    return;
  }
  target.textContent = `nice ${niceValue} • ${selfishnessLabel(niceValue)}`;
}

function bindStaticActions() {
  document.querySelectorAll("[data-spawn-task]").forEach((button) => {
    button.addEventListener("click", () => {
      spawnProcess(button.dataset.spawnTask);
    });
  });

  elements.killAll.addEventListener("click", killAllProcesses);
  elements.spawnChaos.addEventListener("click", spawnChaos);

  elements.refreshInterval.addEventListener("change", () => {
    state.intervalMs = Number(elements.refreshInterval.value);
    connectSocket();
    showToast(`Refresh interval set to ${state.intervalMs}ms.`, "info");
  });

  elements.processGrid.addEventListener("input", (event) => {
    const input = event.target.closest('input[data-action="nice-slider"]');
    if (!input) {
      return;
    }
    updateNicePreview(input);
  });

  elements.processGrid.addEventListener("change", async (event) => {
    const input = event.target.closest('input[data-action="nice-slider"]');
    if (!input) {
      return;
    }
    const pid = Number(input.dataset.pid);
    const niceValue = selfishnessToNice(input.value);
    await setPriority(pid, niceValue);
  });

  const clickHandler = async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const pid = Number(button.dataset.pid);
    const action = button.dataset.action;
    const mb = Number(button.dataset.mb || 0);

    if (action === "increment") {
      await updateThreads(pid, "increment");
      return;
    }

    if (action === "decrement") {
      await updateThreads(pid, "decrement");
      return;
    }

    if (action === "kill") {
      await killProcess(pid);
      return;
    }

    if (action === "reset-affinity") {
      await setAffinity(pid, []);
      return;
    }

    if (action === "toggle-affinity") {
      await toggleAffinity(pid, button.dataset.core);
      return;
    }

    if (action === "inflate-memory") {
      await changeMemory(pid, "inflate", mb);
      return;
    }

    if (action === "deflate-memory") {
      await changeMemory(pid, "deflate", mb);
      return;
    }

    if (action === "release-memory") {
      await changeMemory(pid, "deflate", mb);
    }
  };

  elements.processGrid.addEventListener("click", clickHandler);
  elements.chaosGrid.addEventListener("click", clickHandler);
}

window.addEventListener("beforeunload", () => {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
  }
});

bindStaticActions();
refreshSnapshot();
connectSocket();
