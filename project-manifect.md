# Project Manifest: play-with-process

**Target Stack:** Python 3.11+, FastAPI, TailwindCSS (via CDN), Vanilla JavaScript, HTML5 (WebSockets).

**Target OS:** Linux / macOS

---

## 1. System Architecture Overview

```
[ Web Browser UI ] 
       │  ▲
       │  └─► WebSockets (Live Metrics & Process Tree Updates)
       ▼
[ FastAPI Backend ]
       │
       ├─► Process/Thread Manager (Controls native OS constructs)
       └─► System Monitor (Uses 'psutil' to scrape CPU/Memory/Affinity)

```

### Core Architecture Rules:

* **Monolithic Minimalist Layout:** Single Python file (`main.py`) or a minimal 3-file structure (`main.py`, `index.html`, `app.js`). No build steps (npm/webpack) allowed.
* **Asynchronous Monitoring:** The system metrics and process trees are streamed from Python to the UI via **WebSockets** at a configurable interval (default: 1000ms).
* **State Management:** The backend maintains an in-memory registry of worker processes and their active threads to dynamically manipulate them.

---

## 2. Technical Feature Specifications

### A. The "Task" Engine (CPU Utilization Levels)

Tasks are CPU-bound operations designed to simulate work. The backend supports three predefined intensity levels:

1. **LOW:** Fibonacci/Math loops calculation with short intermittent sleeps (`time.sleep(0.05)`). Low CPU impact.
2. **MEDIUM:** Continuous cryptographic hashing (`hashlib.sha256`) or matrix manipulation targeting ~50% core utilization.
3. **HIGH:** Infinite busy-wait loop (`while True: pass`) to intentionally spike a core to 100%.

### B. Core Functionalities (The "Playground" API)

* **Spawn Process:** Launches a new isolated OS process executing a selected Task level.
* **Scale Threads:** Dynamically adds or terminates standard Python `threading.Thread` instances *inside* a specific spawned process.
* **Set CPU Affinity:** Uses `psutil.Process(pid).cpu_affinity([core_ids])` to bind a specific process or task to distinct physical CPU cores.
* **Kill Process:** Instantly terminates an entire process tree.

### C. Live Dashboard UI

* **System Telemetry:** Real-time grid showing per-core CPU usage percentages and RAM footprint.
* **Interactive Process Tree:** A visual card grid showing:
* Process ID (PID)
* Current CPU Affinity status (e.g., `Cores: [0, 2]`)
* Active Thread Count (with `[+]` and `[-]` buttons to scale real-time)
* A live metric badge showing that specific process's individual CPU/Memory footprint.



---

## 3. Data Structure Contract (JSON Schema)

### Real-Time Update Stream (Backend -> Frontend via WebSocket)

```json
{
  "system": {
    "global_cpu": 45.2,
    "per_core_cpu": [80.1, 12.5, 55.0, 33.1],
    "memory_percent": 62.4
  },
  "processes": [
    {
      "pid": 40213,
      "name": "PlayTask-Medium",
      "cpu_percent": 48.2,
      "memory_mb": 24.5,
      "thread_count": 4,
      "affinity": [0, 1]
    }
  ]
}

```

---

## 4. Prompt Engineering Guide for GitHub Copilot

*Copy and paste these specific prompts into Copilot to build the application iteratively.*

### Step 1: Create the Backend & Process Manager

> **Prompt:** > "Write a FastAPI backend application in Python for a project called 'play-with-process' targetting Linux/macOS. I need a process manager class that can spawn independent worker processes using the `multiprocessing` library. Each process should run a customizable CPU task (Low, Medium, High load). Inside each worker process, it must support dynamically spinning up or killing active `threading.Thread` instances. Use `psutil` to handle fetching process metrics and setting CPU affinity (`cpu_affinity`). Include a WebSocket endpoint `/ws/metrics` that streams global system metrics (per-core CPU, memory) and a list of our active spawned processes with their PIDs, child threads, current CPU/Memory usage, and current affinity list every 1 second."

### Step 2: Create the HTTP Endpoint Handlers

> **Prompt:** > "Add REST API endpoints to the FastAPI application to control the processes. I need:
> 1. POST `/api/process/spawn` (payload: task_type 'LOW'|'MEDIUM'|'HIGH')
> 2. POST `/api/process/{pid}/threads/increment`
> 3. POST `/api/process/{pid}/threads/decrement`
> 4. POST `/api/process/{pid}/affinity` (payload: list of core IDs integer)
> 5. DELETE `/api/process/{pid}` (kills the process cleanly).
> Ensure thread increment/decrement updates the process internal loop safely."
> 
> 

### Step 3: Create the Playful Frontend UI

> **Prompt:** > "Create a single-file interactive front-end dashboard using HTML5, TailwindCSS (loaded via CDN), and vanilla JavaScript. The UI must connect to the backend WebSocket `/ws/metrics`. Split the UI into two sections:
> 1. Top Bar: A visual playground layout showing Per-Core CPU utilization as dynamic progress bars or gauges.
> 2. Bottom Grid: An interactive dashboard displaying cards for each active process. Each process card should show its PID, a badge for its current Task Level, its live CPU usage, buttons to increment `[+]` or decrement `[-]` its thread counts via API calls, a status visualization, and a multiselect pill list to change its CPU core affinity dynamically using fetch API. Make the design dark mode, clean, responsive, and playful."
> 
>