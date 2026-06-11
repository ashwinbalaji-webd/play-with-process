from __future__ import annotations

import asyncio
import gc
import hashlib
import math
import multiprocessing as mp
import threading
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from enum import Enum
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any

import psutil
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
MEGABYTE = 1024 * 1024
DEFAULT_INTERVAL_MS = 1000
MIN_INTERVAL_MS = 250
MAX_INTERVAL_MS = 5000
DEFAULT_CHAOS_DURATION_SECONDS = 10
MAX_MEMORY_STEP_MB = 128
MAX_MEMORY_BALLOON_MB = 512


class TaskType(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class WorkerKind(str, Enum):
    PLAYGROUND = "PLAYGROUND"
    CHAOS = "CHAOS"


class SpawnRequest(BaseModel):
    task_type: TaskType
    initial_threads: int = Field(default=1, ge=1, le=16)


class AffinityRequest(BaseModel):
    cores: list[int] = Field(default_factory=list)


class PriorityRequest(BaseModel):
    nice_value: int = Field(ge=-20, le=19)


class MemoryRequest(BaseModel):
    mb: int = Field(default=32, ge=1, le=MAX_MEMORY_STEP_MB)


class ChaosRequest(BaseModel):
    core: int = Field(ge=0)
    duration_seconds: int = Field(default=DEFAULT_CHAOS_DURATION_SECONDS, ge=3, le=30)


@dataclass
class WorkerHandle:
    process: mp.Process
    connection: Connection
    ps_process: psutil.Process
    task_type: TaskType
    thread_count: int
    worker_kind: WorkerKind = WorkerKind.PLAYGROUND
    label: str | None = None
    created_at: float = field(default_factory=time.time)
    auto_stop_at: float | None = None
    balloon_mb: int = 0
    last_ctx_switches: tuple[int, int] | None = None
    last_ctx_timestamp: float | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def pid(self) -> int:
        return int(self.process.pid or 0)

    @property
    def name(self) -> str:
        if self.label:
            return self.label
        prefix = "Chaos Monkey" if self.worker_kind is WorkerKind.CHAOS else "PlayTask"
        return f"{prefix}-{self.task_type.value.title()}"


def low_intensity_task(stop_event: threading.Event) -> None:
    a, b = 0, 1
    while not stop_event.is_set():
        for _ in range(5000):
            a, b = b, (a + b) % 1_000_003
            math.sqrt((a + b) % 10_000 + 1)
        if stop_event.wait(0.05):
            break


def medium_intensity_task(stop_event: threading.Event) -> None:
    payload = b"play-with-process" * 4096
    while not stop_event.is_set():
        active_until = time.perf_counter() + 0.03
        while time.perf_counter() < active_until and not stop_event.is_set():
            hashlib.sha256(payload).digest()
        if stop_event.wait(0.03):
            break


def high_intensity_task(stop_event: threading.Event) -> None:
    value = 1
    while not stop_event.is_set():
        value = (value * 33 + 7) % 104_729


def run_task(task_type: TaskType, stop_event: threading.Event) -> None:
    if task_type is TaskType.LOW:
        low_intensity_task(stop_event)
        return
    if task_type is TaskType.MEDIUM:
        medium_intensity_task(stop_event)
        return
    high_intensity_task(stop_event)


def worker_main(task_type_value: str, connection: Connection, initial_threads: int) -> None:
    task_type = TaskType(task_type_value)
    thread_slots: list[tuple[threading.Thread, threading.Event]] = []
    balloon_chunks: list[bytearray] = []

    def balloon_total_mb() -> int:
        return len(balloon_chunks)

    def start_thread() -> int:
        stop_event = threading.Event()
        worker = threading.Thread(
            target=run_task,
            args=(task_type, stop_event),
            name=f"{task_type.value.lower()}-worker-{len(thread_slots) + 1}",
            daemon=True,
        )
        thread_slots.append((worker, stop_event))
        worker.start()
        return len(thread_slots)

    def stop_thread() -> int:
        if not thread_slots:
            return 0
        worker, stop_event = thread_slots.pop()
        stop_event.set()
        worker.join(timeout=0.5)
        return len(thread_slots)

    def inflate_memory(mb: int) -> int:
        for _ in range(mb):
            chunk = bytearray(MEGABYTE)
            # Touch each page so RSS rises, not only virtual size.
            for index in range(0, len(chunk), 4096):
                chunk[index] = 1
            balloon_chunks.append(chunk)
        return balloon_total_mb()

    def deflate_memory(mb: int) -> int:
        for _ in range(min(mb, balloon_total_mb())):
            balloon_chunks.pop()
        gc.collect()
        return balloon_total_mb()

    for _ in range(initial_threads):
        start_thread()

    connection.send(
        {
            "status": "ready",
            "thread_count": len(thread_slots),
            "balloon_mb": balloon_total_mb(),
        }
    )

    try:
        while True:
            if not connection.poll(0.25):
                continue

            command = connection.recv()
            action = command.get("action")

            if action == "increment":
                connection.send(
                    {
                        "status": "ok",
                        "thread_count": start_thread(),
                        "balloon_mb": balloon_total_mb(),
                    }
                )
                continue

            if action == "decrement":
                connection.send(
                    {
                        "status": "ok",
                        "thread_count": stop_thread(),
                        "balloon_mb": balloon_total_mb(),
                    }
                )
                continue

            if action == "memory_inflate":
                mb = int(command.get("mb", 0))
                if mb <= 0:
                    connection.send(
                        {
                            "status": "error",
                            "detail": "Inflate amount must be positive.",
                            "thread_count": len(thread_slots),
                            "balloon_mb": balloon_total_mb(),
                        }
                    )
                    continue
                connection.send(
                    {
                        "status": "ok",
                        "thread_count": len(thread_slots),
                        "balloon_mb": inflate_memory(mb),
                    }
                )
                continue

            if action == "memory_deflate":
                mb = int(command.get("mb", 0))
                if mb <= 0:
                    connection.send(
                        {
                            "status": "error",
                            "detail": "Deflate amount must be positive.",
                            "thread_count": len(thread_slots),
                            "balloon_mb": balloon_total_mb(),
                        }
                    )
                    continue
                connection.send(
                    {
                        "status": "ok",
                        "thread_count": len(thread_slots),
                        "balloon_mb": deflate_memory(mb),
                    }
                )
                continue

            if action == "stop":
                connection.send(
                    {
                        "status": "stopping",
                        "thread_count": len(thread_slots),
                        "balloon_mb": balloon_total_mb(),
                    }
                )
                break

            connection.send(
                {
                    "status": "error",
                    "detail": f"Unsupported action '{action}'.",
                    "thread_count": len(thread_slots),
                    "balloon_mb": balloon_total_mb(),
                }
            )
    except EOFError:
        pass
    finally:
        for worker, stop_event in thread_slots:
            stop_event.set()
        for worker, _ in thread_slots:
            worker.join(timeout=0.5)
        balloon_chunks.clear()
        gc.collect()
        with suppress(Exception):
            connection.close()


class ProcessManager:
    def __init__(self) -> None:
        self.ctx = mp.get_context("spawn")
        self.registry: dict[int, WorkerHandle] = {}
        self.registry_lock = threading.Lock()
        self.logical_cpus = psutil.cpu_count(logical=True) or 1
        self.affinity_supported = self._detect_affinity_support()

    def _detect_affinity_support(self) -> bool:
        process = psutil.Process()
        if not hasattr(process, "cpu_affinity"):
            return False
        try:
            process.cpu_affinity()
        except (AttributeError, NotImplementedError):
            return False
        except psutil.Error:
            return True
        return True

    def tracked_count(self) -> int:
        with self.registry_lock:
            return len(self.registry)

    def _get_handle(self, pid: int) -> WorkerHandle:
        with self.registry_lock:
            handle = self.registry.get(pid)
        if handle is None or not handle.process.is_alive():
            self._drop_handle(pid)
            raise KeyError(pid)
        return handle

    def _drop_handle(self, pid: int) -> None:
        with self.registry_lock:
            handle = self.registry.pop(pid, None)
        if handle is None:
            return
        with suppress(Exception):
            handle.connection.close()
        with suppress(Exception):
            handle.process.join(timeout=0.2)

    def _send_command(self, handle: WorkerHandle, action: str, **payload: Any) -> dict[str, Any]:
        with handle.lock:
            try:
                handle.connection.send({"action": action, **payload})
                if not handle.connection.poll(3.0):
                    raise RuntimeError("Worker did not respond in time.")
                response = handle.connection.recv()
            except (BrokenPipeError, EOFError, OSError) as exc:
                self._drop_handle(handle.pid)
                raise RuntimeError("Worker connection is no longer available.") from exc

        if response.get("status") == "error":
            raise RuntimeError(response.get("detail", "Worker rejected the command."))
        return response

    def prime_metrics(self) -> None:
        psutil.cpu_percent(interval=None, percpu=True)

    def spawn(
        self,
        task_type: TaskType,
        initial_threads: int = 1,
        worker_kind: WorkerKind = WorkerKind.PLAYGROUND,
        label: str | None = None,
        auto_stop_after: float | None = None,
    ) -> WorkerHandle:
        parent_conn, child_conn = self.ctx.Pipe()
        process = self.ctx.Process(
            target=worker_main,
            args=(task_type.value, child_conn, initial_threads),
            name=label or f"PlayTask-{task_type.value.title()}",
        )
        process.start()
        child_conn.close()

        if not parent_conn.poll(5.0):
            with suppress(Exception):
                process.terminate()
            raise RuntimeError("Worker failed to start.")

        ready_message = parent_conn.recv()
        ps_process = psutil.Process(process.pid)
        ps_process.cpu_percent(interval=None)

        handle = WorkerHandle(
            process=process,
            connection=parent_conn,
            ps_process=ps_process,
            task_type=task_type,
            thread_count=int(ready_message.get("thread_count", initial_threads)),
            worker_kind=worker_kind,
            label=label,
            auto_stop_at=time.time() + auto_stop_after if auto_stop_after else None,
            balloon_mb=int(ready_message.get("balloon_mb", 0)),
        )

        with self.registry_lock:
            self.registry[handle.pid] = handle

        if auto_stop_after:
            threading.Thread(
                target=self._kill_later,
                args=(handle.pid, auto_stop_after),
                name=f"chaos-stop-{handle.pid}",
                daemon=True,
            ).start()

        return handle

    def _kill_later(self, pid: int, delay_seconds: float) -> None:
        time.sleep(delay_seconds)
        with suppress(Exception):
            self.kill_process(pid)

    def increment_threads(self, pid: int) -> WorkerHandle:
        handle = self._get_handle(pid)
        response = self._send_command(handle, "increment")
        handle.thread_count = int(response.get("thread_count", handle.thread_count + 1))
        handle.balloon_mb = int(response.get("balloon_mb", handle.balloon_mb))
        return handle

    def decrement_threads(self, pid: int) -> WorkerHandle:
        handle = self._get_handle(pid)
        response = self._send_command(handle, "decrement")
        handle.thread_count = int(response.get("thread_count", max(0, handle.thread_count - 1)))
        handle.balloon_mb = int(response.get("balloon_mb", handle.balloon_mb))
        return handle

    def inflate_memory(self, pid: int, mb: int) -> dict[str, Any]:
        handle = self._get_handle(pid)
        if handle.balloon_mb + mb > MAX_MEMORY_BALLOON_MB:
            raise ValueError(
                f"This worker is capped at {MAX_MEMORY_BALLOON_MB} MB of manual balloon memory."
            )
        response = self._send_command(handle, "memory_inflate", mb=mb)
        handle.balloon_mb = int(response.get("balloon_mb", handle.balloon_mb + mb))
        return {"pid": handle.pid, "balloon_mb": handle.balloon_mb}

    def deflate_memory(self, pid: int, mb: int) -> dict[str, Any]:
        handle = self._get_handle(pid)
        response = self._send_command(handle, "memory_deflate", mb=mb)
        handle.balloon_mb = int(response.get("balloon_mb", max(0, handle.balloon_mb - mb)))
        return {"pid": handle.pid, "balloon_mb": handle.balloon_mb}

    def set_affinity(self, pid: int, cores: list[int]) -> dict[str, Any]:
        handle = self._get_handle(pid)
        normalized = sorted(set(cores))

        if any(core < 0 or core >= self.logical_cpus for core in normalized):
            raise ValueError(f"Core ids must be between 0 and {self.logical_cpus - 1}.")

        if not self.affinity_supported:
            raise NotImplementedError("CPU affinity is not available on this platform.")

        try:
            handle.ps_process.cpu_affinity(normalized if normalized else [])
        except (AttributeError, NotImplementedError) as exc:
            raise NotImplementedError("CPU affinity is not available on this platform.") from exc
        except psutil.Error as exc:
            raise RuntimeError(str(exc)) from exc

        return {"pid": handle.pid, "affinity": self._safe_affinity(handle.ps_process)}

    def set_priority(self, pid: int, nice_value: int) -> dict[str, Any]:
        handle = self._get_handle(pid)
        try:
            handle.ps_process.nice(nice_value)
        except psutil.AccessDenied as exc:
            raise PermissionError(
                "Lowering niceness below the current value usually needs elevated privileges."
            ) from exc
        except psutil.Error as exc:
            raise RuntimeError(str(exc)) from exc

        return {"pid": handle.pid, "nice_value": self._safe_nice(handle.ps_process)}

    def spawn_chaos(self, core: int, duration_seconds: int) -> WorkerHandle:
        if core < 0 or core >= self.logical_cpus:
            raise ValueError(f"Core ids must be between 0 and {self.logical_cpus - 1}.")
        if not self.affinity_supported:
            raise NotImplementedError("Chaos Monkey needs CPU affinity support on this platform.")

        handle = self.spawn(
            TaskType.HIGH,
            initial_threads=1,
            worker_kind=WorkerKind.CHAOS,
            label=f"Chaos Monkey Core {core}",
            auto_stop_after=duration_seconds,
        )

        try:
            self.set_affinity(handle.pid, [core])
        except Exception:
            with suppress(Exception):
                self.kill_process(handle.pid)
            raise

        return handle

    def kill_process(self, pid: int) -> None:
        handle = self._get_handle(pid)

        with suppress(Exception):
            self._send_command(handle, "stop")

        descendants: list[psutil.Process] = []
        with suppress(psutil.Error):
            descendants = handle.ps_process.children(recursive=True)

        for child in descendants:
            with suppress(psutil.Error):
                child.terminate()

        if handle.process.is_alive():
            handle.process.terminate()
            handle.process.join(timeout=1.0)

        if handle.process.is_alive():
            handle.process.kill()
            handle.process.join(timeout=1.0)

        for child in descendants:
            with suppress(psutil.Error):
                if child.is_running():
                    child.kill()

        self._drop_handle(pid)

    def kill_all(self) -> int:
        with self.registry_lock:
            pids = list(self.registry.keys())

        for pid in pids:
            with suppress(Exception):
                self.kill_process(pid)
        return len(pids)

    def shutdown(self) -> None:
        self.kill_all()

    def _safe_affinity(self, process: psutil.Process) -> list[int]:
        if not self.affinity_supported:
            return []
        try:
            return list(process.cpu_affinity())
        except (AttributeError, NotImplementedError, psutil.Error):
            return []

    def _safe_cpu_num(self, process: psutil.Process) -> int | None:
        try:
            return int(process.cpu_num())
        except (AttributeError, NotImplementedError, psutil.Error, TypeError, ValueError):
            return None

    def _safe_nice(self, process: psutil.Process) -> int | None:
        try:
            value = process.nice()
        except psutil.Error:
            return None
        return int(value) if isinstance(value, int) else None

    def _safe_status(self, process: psutil.Process) -> str:
        try:
            return process.status()
        except psutil.Error:
            return "unknown"

    def _context_switch_snapshot(self, handle: WorkerHandle) -> dict[str, float | int]:
        current = handle.ps_process.num_ctx_switches()
        current_pair = (int(current.voluntary), int(current.involuntary))
        current_timestamp = time.time()

        voluntary_per_sec = 0.0
        involuntary_per_sec = 0.0

        if handle.last_ctx_switches and handle.last_ctx_timestamp:
            elapsed = max(current_timestamp - handle.last_ctx_timestamp, 0.001)
            previous_voluntary, previous_involuntary = handle.last_ctx_switches
            voluntary_per_sec = max(0.0, (current_pair[0] - previous_voluntary) / elapsed)
            involuntary_per_sec = max(0.0, (current_pair[1] - previous_involuntary) / elapsed)

        handle.last_ctx_switches = current_pair
        handle.last_ctx_timestamp = current_timestamp

        return {
            "voluntary_total": current_pair[0],
            "involuntary_total": current_pair[1],
            "voluntary_per_sec": round(voluntary_per_sec, 1),
            "involuntary_per_sec": round(involuntary_per_sec, 1),
        }

    def _observation_hints(
        self,
        handle: WorkerHandle,
        snapshot: dict[str, Any],
    ) -> list[str]:
        hints: list[str] = []
        affinity = snapshot["affinity"]
        current_cpu = snapshot["current_cpu"]
        ctx = snapshot["context_switches"]
        nice_value = snapshot["nice_value"]

        if handle.worker_kind is WorkerKind.CHAOS:
            target = affinity[0] if affinity else "its selected core"
            hints.append(
                f"This is intentional outside pressure pinned to core {target}. Unpinned workers may migrate away from it."
            )
            hints.append(
                "Pinned workers cannot escape. Their involuntary context switches should climb if they fight over that same core."
            )
            return hints

        if handle.task_type is TaskType.HIGH and handle.thread_count == 1:
            hints.append(
                "One busy Python thread usually burns about one logical CPU in total, not every allowed core at once."
            )

        if affinity:
            if len(affinity) == 1:
                hints.append(
                    f"Pinned to core {affinity[0]}. Compare that core's bar with this PID's CPU and Current CPU; other bars still include unrelated system work."
                )
            elif current_cpu is not None:
                hints.append(
                    f"This worker may hop between any allowed core. The scheduler sampled it on CPU {current_cpu} right now."
                )

        if handle.task_type in {TaskType.LOW, TaskType.MEDIUM}:
            hints.append(
                "LOW and MEDIUM intentionally pause, so they should look bursty and accumulate more voluntary context switches."
            )
        elif ctx["involuntary_per_sec"] > ctx["voluntary_per_sec"]:
            hints.append(
                "Involuntary switches are winning right now, which usually means the kernel is preempting this process because other runnable work is competing."
            )

        if snapshot["balloon_mb"] > 0:
            hints.append(
                "This worker is holding extra touched memory. RSS shows what is resident in RAM; VMS covers the larger virtual address space."
            )

        if nice_value is not None:
            if nice_value > 0:
                hints.append(
                    "Positive niceness makes this worker more polite. On a shared core it should surrender more CPU time to more selfish neighbors."
                )
            elif nice_value < 0:
                hints.append(
                    "Negative niceness makes this worker more selfish. On a shared core it should win more CPU time, if the OS lets you set it."
                )

        return hints[:3]

    def _describe_handle(self, handle: WorkerHandle) -> dict[str, Any]:
        with handle.ps_process.oneshot():
            memory_info = handle.ps_process.memory_info()
            cpu_percent = handle.ps_process.cpu_percent(interval=None)
            affinity = self._safe_affinity(handle.ps_process)
            current_cpu = self._safe_cpu_num(handle.ps_process)
            nice_value = self._safe_nice(handle.ps_process)
            status = self._safe_status(handle.ps_process)

        context_switches = self._context_switch_snapshot(handle)
        snapshot: dict[str, Any] = {
            "pid": handle.pid,
            "name": handle.name,
            "task_type": handle.task_type.value,
            "worker_kind": handle.worker_kind.value,
            "cpu_percent": round(cpu_percent, 1),
            "core_equivalent": round(cpu_percent / 100, 2),
            "memory_mb": round(memory_info.rss / MEGABYTE, 1),
            "rss_mb": round(memory_info.rss / MEGABYTE, 1),
            "vms_mb": round(memory_info.vms / MEGABYTE, 1),
            "thread_count": handle.thread_count,
            "affinity": affinity,
            "affinity_supported": self.affinity_supported,
            "status": status,
            "nice_value": nice_value,
            "current_cpu": current_cpu,
            "context_switches": context_switches,
            "balloon_mb": handle.balloon_mb,
            "uptime_seconds": round(time.time() - handle.created_at, 1),
            "auto_stop_at": handle.auto_stop_at,
        }
        snapshot["observation_hints"] = self._observation_hints(handle, snapshot)
        return snapshot

    def system_snapshot(self) -> dict[str, Any]:
        per_core = [round(value, 1) for value in psutil.cpu_percent(interval=None, percpu=True)]
        global_cpu = round(sum(per_core) / len(per_core), 1) if per_core else 0.0
        return {
            "global_cpu": global_cpu,
            "per_core_cpu": per_core,
            "memory_percent": round(psutil.virtual_memory().percent, 1),
        }

    def snapshot(self, interval_ms: int = DEFAULT_INTERVAL_MS) -> dict[str, Any]:
        with self.registry_lock:
            handles = list(self.registry.values())

        processes: list[dict[str, Any]] = []
        stale_pids: list[int] = []

        for handle in handles:
            if not handle.process.is_alive():
                stale_pids.append(handle.pid)
                continue

            try:
                processes.append(self._describe_handle(handle))
            except psutil.Error:
                stale_pids.append(handle.pid)

        for pid in stale_pids:
            self._drop_handle(pid)

        processes.sort(key=lambda item: (item["worker_kind"] != WorkerKind.CHAOS.value, item["pid"]))

        return {
            "meta": {
                "timestamp": time.time(),
                "interval_ms": interval_ms,
                "available_cores": list(range(self.logical_cpus)),
                "affinity_supported": self.affinity_supported,
                "memory_balloon_limit_mb": MAX_MEMORY_BALLOON_MB,
                "memory_step_limit_mb": MAX_MEMORY_STEP_MB,
                "chaos_default_duration_seconds": DEFAULT_CHAOS_DURATION_SECONDS,
            },
            "system": self.system_snapshot(),
            "processes": processes,
        }


def clamp_interval(raw_value: str | None) -> int:
    if raw_value is None:
        return DEFAULT_INTERVAL_MS
    try:
        value = int(raw_value)
    except ValueError:
        return DEFAULT_INTERVAL_MS
    return max(MIN_INTERVAL_MS, min(MAX_INTERVAL_MS, value))


manager = ProcessManager()


@asynccontextmanager
async def lifespan(_: FastAPI):
    manager.prime_metrics()
    yield
    manager.shutdown()


app = FastAPI(
    title="play-with-process",
    summary="Interactive process playground for CPU load, threads, affinity, niceness, and memory.",
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def healthcheck() -> dict[str, Any]:
    return {
        "status": "ok",
        "tracked_processes": manager.tracked_count(),
        "affinity_supported": manager.affinity_supported,
    }


@app.get("/api/processes")
async def list_processes() -> dict[str, Any]:
    return manager.snapshot()


@app.post("/api/process/spawn")
async def spawn_process(payload: SpawnRequest) -> dict[str, Any]:
    try:
        handle = manager.spawn(payload.task_type, payload.initial_threads)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "ok": True,
        "process": {
            "pid": handle.pid,
            "name": handle.name,
            "task_type": handle.task_type.value,
            "thread_count": handle.thread_count,
            "worker_kind": handle.worker_kind.value,
        },
    }


@app.post("/api/chaos/spawn")
async def spawn_chaos(payload: ChaosRequest) -> dict[str, Any]:
    try:
        handle = manager.spawn_chaos(payload.core, payload.duration_seconds)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "ok": True,
        "process": {
            "pid": handle.pid,
            "name": handle.name,
            "task_type": handle.task_type.value,
            "thread_count": handle.thread_count,
            "worker_kind": handle.worker_kind.value,
            "auto_stop_at": handle.auto_stop_at,
        },
    }


@app.post("/api/process/{pid}/threads/increment")
async def increment_threads(pid: int) -> dict[str, Any]:
    try:
        handle = manager.increment_threads(pid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Process not found.") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"ok": True, "pid": handle.pid, "thread_count": handle.thread_count}


@app.post("/api/process/{pid}/threads/decrement")
async def decrement_threads(pid: int) -> dict[str, Any]:
    try:
        handle = manager.decrement_threads(pid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Process not found.") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"ok": True, "pid": handle.pid, "thread_count": handle.thread_count}


@app.post("/api/process/{pid}/affinity")
async def set_affinity(pid: int, payload: AffinityRequest) -> dict[str, Any]:
    try:
        result = manager.set_affinity(pid, payload.cores)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Process not found.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"ok": True, **result}


@app.post("/api/process/{pid}/priority")
async def set_priority(pid: int, payload: PriorityRequest) -> dict[str, Any]:
    try:
        result = manager.set_priority(pid, payload.nice_value)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Process not found.") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"ok": True, **result}


@app.post("/api/process/{pid}/memory/inflate")
async def inflate_memory(pid: int, payload: MemoryRequest) -> dict[str, Any]:
    try:
        result = manager.inflate_memory(pid, payload.mb)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Process not found.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"ok": True, **result}


@app.post("/api/process/{pid}/memory/deflate")
async def deflate_memory(pid: int, payload: MemoryRequest) -> dict[str, Any]:
    try:
        result = manager.deflate_memory(pid, payload.mb)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Process not found.") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"ok": True, **result}


@app.delete("/api/process/{pid}")
async def delete_process(pid: int) -> dict[str, Any]:
    try:
        manager.kill_process(pid)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Process not found.") from exc

    return {"ok": True, "pid": pid}


@app.delete("/api/processes")
async def delete_all_processes() -> dict[str, Any]:
    return {"ok": True, "terminated": manager.kill_all()}


@app.websocket("/ws/metrics")
async def metrics_socket(websocket: WebSocket) -> None:
    interval_ms = clamp_interval(websocket.query_params.get("interval_ms"))
    await websocket.accept()

    try:
        while True:
            await websocket.send_json(manager.snapshot(interval_ms=interval_ms))
            await asyncio.sleep(interval_ms / 1000)
    except WebSocketDisconnect:
        return


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
