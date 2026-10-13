# -*- coding: utf-8 -*-
"""Lazy 资源监控：本机 / ComfyUI 进程 的内存与显存。"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from typing import Any

_registered_routes: set = set()
_pending_routes: list = []
_nvml_ok = None  # None=未试, True/False

# 进程启动以来的峰值（后端侧，跨请求保留）
_peaks = {
    "sys_ram_used": 0.0,
    "proc_ram_used": 0.0,
    "sys_vram_used": 0.0,
    "proc_vram_used": 0.0,
}
_lock = threading.Lock()
_sampler_started = False
_pws_api = None  # None=未试, False=不可用, tuple=已就绪

_PID_RE = re.compile(r"pid_(\d+)_", re.I)
_MAX_REASONABLE = float(1 << 40)  # ≥1TiB 视为 NVML N/A 或脏数据


def _bytes_to_gb(n: float) -> float:
    return round(float(n) / (1024 ** 3), 3)


def _valid_bytes(n: Any) -> float:
    try:
        v = float(n)
    except Exception:
        return 0.0
    if v <= 0.0 or v >= _MAX_REASONABLE:
        return 0.0
    return v


def _get_process():
    try:
        import psutil
        return psutil.Process(os.getpid())
    except Exception:
        return None


# 再往上就是系统或终端，不能算进 ComfyUI。
_STOP_PARENTS = {
    "explorer.exe", "svchost.exe", "services.exe", "wininit.exe", "winlogon.exe",
    "lsass.exe", "csrss.exe", "dwm.exe", "sihost.exe", "taskhostw.exe",
    "runtimebroker.exe", "searchhost.exe", "startmenuexperiencehost.exe",
    "shellexperiencehost.exe", "system", "registry", "smss.exe", "fontdrvhost.exe",
    "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe",
    "conhost.exe", "wt.exe", "openconsole.exe",
}


def _proc_name(proc) -> str:
    try:
        return str(proc.name() or "").lower()
    except Exception:
        return ""


def _proc_cmd(proc) -> str:
    try:
        return " ".join(proc.cmdline() or []).lower()
    except Exception:
        return ""


def _is_comfy_runtime(proc) -> bool:
    """桌面壳、后端和它们的启动器，都算这一次 ComfyUI 运行。"""
    name = _proc_name(proc)
    if not name or name in _STOP_PARENTS:
        return False
    if "comfy" in name:
        return True
    cmd = _proc_cmd(proc)
    if "comfy" in cmd:
        return True
    if name in ("python.exe", "pythonw.exe", "uv.exe") and (
        "main.py" in cmd or "comfy" in cmd
    ):
        return True
    return False


def _comfy_runtime_root(start_pid: int | None = None):
    """从当前后端往上收到整份 ComfyUI 的根进程。"""
    try:
        import psutil
        cur = psutil.Process(int(start_pid or os.getpid()))
    except Exception:
        return None
    root = cur
    seen = set()
    while cur is not None and cur.pid not in seen:
        seen.add(cur.pid)
        try:
            parent = cur.parent()
        except Exception:
            break
        if parent is None:
            break
        if not _is_comfy_runtime(parent):
            break
        root = parent
        cur = parent
    return root


def _pids_from(root) -> set[int]:
    pids = set()
    if root is None:
        pids.add(os.getpid())
        return pids
    try:
        pids.add(int(root.pid))
    except Exception:
        pids.add(os.getpid())
    try:
        for child in root.children(recursive=True):
            try:
                pids.add(int(child.pid))
            except Exception:
                pass
    except Exception:
        pass
    pids.add(os.getpid())
    return pids


def _comfy_pids() -> set[int]:
    """后端进程及子进程。显存仍按这一支算。"""
    pids = {os.getpid()}
    try:
        import psutil
        me = psutil.Process(os.getpid())
        for c in me.children(recursive=True):
            try:
                pids.add(int(c.pid))
            except Exception:
                pass
    except Exception:
        pass
    return pids


def _comfy_runtime_pids() -> set[int]:
    """整份 ComfyUI 运行：桌面壳 + 后端 + 子进程。"""
    return _pids_from(_comfy_runtime_root())


def _sys_ram() -> tuple[float, float, float]:
    """total, used, percent（used = total - available，与任务管理器可用内存口径一致）"""
    try:
        import psutil
        vm = psutil.virtual_memory()
        total = float(vm.total)
        avail = float(getattr(vm, "available", 0) or 0)
        used = (total - avail) if avail > 0 else float(vm.used)
        used = max(0.0, min(used, total)) if total > 0 else 0.0
        pct = (used / total * 100.0) if total > 0 else 0.0
        return total, used, pct
    except Exception:
        return 0.0, 0.0, 0.0


def _pws_get_api():
    """Windows GetProcessMemoryInfo(EX2) 惰性初始化。"""
    global _pws_api
    if _pws_api is False:
        return None
    if _pws_api is not None:
        return _pws_api
    if os.name != "nt":
        _pws_api = False
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class _PMC_EX2(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
                ("PrivateUsage", ctypes.c_size_t),
                ("PrivateWorkingSetSize", ctypes.c_size_t),
                ("SharedCommitUsage", ctypes.c_size_t),
            ]

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.CloseHandle.restype = wintypes.BOOL
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        psapi.GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        _pws_api = (k32, psapi, _PMC_EX2)
        return _pws_api
    except Exception:
        _pws_api = False
        return None


def _win_process_ram(pid: int) -> float:
    """进程正在占用的物理内存（专用工作集）。不用提交量，提交量含页面文件。"""
    api = _pws_get_api()
    if not api:
        return 0.0
    import ctypes
    k32, psapi, pmc_cls = api
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    PROCESS_QUERY_INFORMATION = 0x0400
    PROCESS_VM_READ = 0x0010
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, int(pid))
    if not h:
        h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, int(pid))
    if not h:
        return 0.0
    try:
        info = pmc_cls()
        info.cb = ctypes.sizeof(info)
        if not psapi.GetProcessMemoryInfo(h, ctypes.byref(info), info.cb):
            return 0.0
        # 专用工作集才是这块进程现在占着的物理内存，不会超过整机已用。
        resident = float(info.PrivateWorkingSetSize or 0)
        if resident <= 0.0:
            resident = float(info.WorkingSetSize or 0)
        return resident
    except Exception:
        return 0.0
    finally:
        try:
            k32.CloseHandle(h)
        except Exception:
            pass


def _psutil_ram(pid: int) -> float:
    """psutil 兜底：物理内存。Windows 优先 USS，不用 Private（那是提交量）。"""
    try:
        import psutil
        proc = psutil.Process(int(pid))
    except Exception:
        return 0.0
    if os.name == "nt":
        try:
            uss = float(getattr(proc.memory_full_info(), "uss", 0) or 0)
            if uss > 0.0:
                return uss
        except Exception:
            pass
    try:
        mi = proc.memory_info()
        if os.name == "nt":
            wset = float(getattr(mi, "wset", 0) or 0)
            if wset > 0.0:
                return wset
        return float(getattr(mi, "rss", 0) or 0)
    except Exception:
        return 0.0


def _proc_pid_ram(pid: int) -> float:
    """单进程当前占用的物理内存。"""
    if os.name == "nt":
        cur = _win_process_ram(pid)
        if cur > 0.0:
            return cur
    return _psutil_ram(pid)


def _proc_ram_pair(pids: set[int]) -> tuple[float, float]:
    """返回 (当前物理占用合计, 0)。峰值由采样取 max。"""
    used = 0.0
    if not pids:
        return 0.0, 0.0
    for pid in pids:
        used += _proc_pid_ram(int(pid))
    return used, 0.0


def _proc_ram(proc) -> float:
    pids = _comfy_runtime_pids()
    rss, _ = _proc_ram_pair(pids)
    if rss > 0:
        return rss
    if proc is None:
        return 0.0
    try:
        total = _psutil_ram(int(proc.pid))
        try:
            for c in proc.children(recursive=True):
                try:
                    total += _psutil_ram(int(c.pid))
                except Exception:
                    pass
        except Exception:
            pass
        return total
    except Exception:
        return 0.0


def _nvml():
    """返回 pynvml 模块或 None。"""
    global _nvml_ok
    if _nvml_ok is False:
        return None
    try:
        import pynvml
        if _nvml_ok is None:
            pynvml.nvmlInit()
            _nvml_ok = True
        return pynvml
    except Exception:
        _nvml_ok = False
        return None


def _nvml_process_lists(pynvml, handle):
    """兼容不同驱动的进程列表 API。"""
    procs = []
    for fn_name in (
        "nvmlDeviceGetComputeRunningProcesses_v3",
        "nvmlDeviceGetComputeRunningProcesses_v2",
        "nvmlDeviceGetComputeRunningProcesses",
    ):
        fn = getattr(pynvml, fn_name, None)
        if not fn:
            continue
        try:
            procs = list(fn(handle) or [])
            break
        except Exception:
            continue
    # 图形进程也算（部分场景只出现在这里）
    for fn_name in (
        "nvmlDeviceGetGraphicsRunningProcesses_v3",
        "nvmlDeviceGetGraphicsRunningProcesses_v2",
        "nvmlDeviceGetGraphicsRunningProcesses",
    ):
        fn = getattr(pynvml, fn_name, None)
        if not fn:
            continue
        try:
            procs = procs + list(fn(handle) or [])
            break
        except Exception:
            continue
    return procs


# —— Windows PDH：GPU Process Memory Dedicated Usage（WDDM 下 NVML 进程显存为 N/A）——
_pdh_ok = None
_pdh_mod = None
_pdh_query = None
_pdh_counter = None
_pdh_buf = None


def _pdh_close() -> None:
    global _pdh_query, _pdh_counter, _pdh_buf
    q = _pdh_query
    _pdh_query = None
    _pdh_counter = None
    _pdh_buf = None
    if q is None or _pdh_mod is None:
        return
    try:
        _pdh_mod.PdhCloseQuery(q)
    except Exception:
        pass


def _pdh_init() -> bool:
    """初始化持久 PDH 查询。短暂失败后允许重试。"""
    global _pdh_ok, _pdh_mod, _pdh_query, _pdh_counter
    if _pdh_query is not None and _pdh_counter is not None:
        return True
    if os.name != "nt":
        _pdh_ok = False
        return False
    if _pdh_ok is False:
        if time.time() - getattr(_pdh_init, "_fail_ts", 0.0) < 3.0:
            return False
        _pdh_ok = None
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        _pdh_ok = False
        return False
    try:
        pdh = ctypes.WinDLL("pdh")
        _pdh_mod = pdh
        h_query = ctypes.c_void_p()
        if int(pdh.PdhOpenQueryW(None, None, ctypes.byref(h_query))) != 0:
            _pdh_init._fail_ts = time.time()
            _pdh_ok = False
            return False
        h_counter = ctypes.c_void_p()
        path = "\\GPU Process Memory(*)\\Dedicated Usage"
        add_en = getattr(pdh, "PdhAddEnglishCounterW", None)
        status = 1
        if add_en is not None:
            status = int(add_en(h_query, path, None, ctypes.byref(h_counter)))
        if status != 0:
            status = int(pdh.PdhAddCounterW(h_query, path, None, ctypes.byref(h_counter)))
        if status != 0:
            try:
                pdh.PdhCloseQuery(h_query)
            except Exception:
                pass
            _pdh_init._fail_ts = time.time()
            _pdh_ok = False
            return False
        pdh.PdhCollectQueryData(h_query)  # 预热
        _pdh_query = h_query
        _pdh_counter = h_counter
        _pdh_ok = True
        return True
    except Exception:
        _pdh_close()
        _pdh_init._fail_ts = time.time()
        _pdh_ok = False
        return False


def _proc_vram_windows(pids: set[int]) -> float:
    """Windows 性能计数器：进程独占显存（字节）。WDDM 下这是唯一准确的进程显存。"""
    if os.name != "nt" or not pids:
        return 0.0
    if not _pdh_init():
        return 0.0
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        return 0.0

    pdh = _pdh_mod
    PDH_FMT_LARGE = 0x00000400
    PDH_FMT_NOSCALE = 0x00001000
    PDH_MORE_DATA = 0x800007D2

    class _FmtVal(ctypes.Structure):
        _fields_ = [
            ("CStatus", wintypes.DWORD),
            ("_pad", wintypes.DWORD),
            ("largeValue", ctypes.c_longlong),
        ]

    class _FmtItem(ctypes.Structure):
        _fields_ = [
            ("szName", ctypes.c_wchar_p),
            ("FmtValue", _FmtVal),
        ]

    try:
        st = int(pdh.PdhCollectQueryData(_pdh_query))
        if st != 0:
            _pdh_close()
            return 0.0
        buf_size = wintypes.DWORD(0)
        item_count = wintypes.DWORD(0)
        flags = PDH_FMT_LARGE | PDH_FMT_NOSCALE
        st = int(
            pdh.PdhGetFormattedCounterArrayW(
                _pdh_counter, flags, ctypes.byref(buf_size), ctypes.byref(item_count), None
            )
        ) & 0xFFFFFFFF
        if st != PDH_MORE_DATA or buf_size.value <= 0:
            return 0.0
        buf = (ctypes.c_byte * buf_size.value)()
        st = int(
            pdh.PdhGetFormattedCounterArrayW(
                _pdh_counter, flags, ctypes.byref(buf_size), ctypes.byref(item_count), buf
            )
        )
        if st != 0 or item_count.value <= 0:
            return 0.0
        arr = (_FmtItem * item_count.value).from_buffer(buf)
        used = 0.0
        seen = set()
        for it in arr:
            name = it.szName or ""
            m = _PID_RE.search(name)
            if not m:
                continue
            pid = int(m.group(1))
            if pid not in pids:
                continue
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            used += _valid_bytes(it.FmtValue.largeValue)
        # 保持 buf 直到循环结束（szName 指向 buf）
        _ = buf
        return used
    except Exception:
        try:
            _pdh_close()
        except Exception:
            pass
        return 0.0


def _sys_vram_nvml() -> tuple[float, float, float, str] | None:
    """本机显存 total, used, percent, name（可多卡合计 used/total 取主卡名）。"""
    pynvml = _nvml()
    if not pynvml:
        return None
    try:
        count = int(pynvml.nvmlDeviceGetCount())
        if count <= 0:
            return None
        total_all = 0.0
        used_all = 0.0
        name0 = "GPU"
        for i in range(count):
            h = pynvml.nvmlDeviceGetHandleByIndex(i)
            info = pynvml.nvmlDeviceGetMemoryInfo(h)
            total_all += float(info.total)
            used_all += float(info.used)
            if i == 0:
                try:
                    n = pynvml.nvmlDeviceGetName(h)
                    if isinstance(n, bytes):
                        n = n.decode("utf-8", errors="ignore")
                    name0 = str(n)
                except Exception:
                    pass
        pct = (used_all / total_all * 100.0) if total_all > 0 else 0.0
        return total_all, used_all, pct, name0
    except Exception:
        return None


def _sys_vram_torch() -> tuple[float, float, float, str] | None:
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        total_all = 0.0
        used_all = 0.0
        name0 = ""
        for i in range(torch.cuda.device_count()):
            free, total = torch.cuda.mem_get_info(i)
            free, total = float(free), float(total)
            total_all += total
            used_all += max(0.0, total - free)
            if i == 0:
                try:
                    name0 = torch.cuda.get_device_name(i)
                except Exception:
                    name0 = "CUDA"
        pct = (used_all / total_all * 100.0) if total_all > 0 else 0.0
        return total_all, used_all, pct, name0
    except Exception:
        return None


def _sys_vram(allow_smi: bool = True) -> tuple[float, float, float, str]:
    """total, used, percent, device_name — 优先 NVML（全局准确）。"""
    r = _sys_vram_nvml()
    if r is not None and r[0] > 0:
        return r
    r = _sys_vram_torch()
    if r is not None and r[0] > 0:
        return r
    if not allow_smi:
        return 0.0, 0.0, 0.0, ""
    # nvidia-smi 兜底
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=memory.total,memory.used,name",
                "--format=csv,noheader,nounits",
            ],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2.0,
        )
        total_all = used_all = 0.0
        name0 = "GPU"
        for i, line in enumerate(out.strip().splitlines()):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2:
                continue
            # nvidia-smi 单位 MiB
            t_mib = float(parts[0])
            u_mib = float(parts[1])
            total_all += t_mib * 1024 * 1024
            used_all += u_mib * 1024 * 1024
            if i == 0 and len(parts) >= 3:
                name0 = parts[2]
        if total_all > 0:
            pct = used_all / total_all * 100.0
            return total_all, used_all, pct, name0
    except Exception:
        pass
    return 0.0, 0.0, 0.0, ""


def _proc_vram_nvml(pids: set[int]) -> float:
    """NVML：统计 pids 在所有 GPU 上的 usedGpuMemory。WDDM 下常为 N/A，需过滤。"""
    pynvml = _nvml()
    if not pynvml:
        return 0.0
    used = 0.0
    seen = set()  # (gpu, pid) 去重
    try:
        count = int(pynvml.nvmlDeviceGetCount())
        for i in range(count):
            h = pynvml.nvmlDeviceGetHandleByIndex(i)
            for p in _nvml_process_lists(pynvml, h):
                try:
                    pid = int(getattr(p, "pid", -1))
                except Exception:
                    continue
                if pid not in pids:
                    continue
                key = (i, pid)
                if key in seen:
                    continue
                seen.add(key)
                try:
                    used += _valid_bytes(getattr(p, "usedGpuMemory", 0))
                except Exception:
                    pass
    except Exception:
        return 0.0
    return used


def _proc_vram_torch() -> tuple[float, float]:
    """PyTorch 本进程 reserved / max_reserved（含子设备）。"""
    try:
        import torch
        if not torch.cuda.is_available():
            return 0.0, 0.0
        cur = 0.0
        peak = 0.0
        for i in range(torch.cuda.device_count()):
            try:
                cur += float(torch.cuda.memory_reserved(i))
            except Exception:
                try:
                    cur += float(torch.cuda.memory_allocated(i))
                except Exception:
                    pass
            try:
                peak += float(torch.cuda.max_memory_reserved(i))
            except Exception:
                try:
                    peak += float(torch.cuda.max_memory_allocated(i))
                except Exception:
                    pass
        return _valid_bytes(cur), _valid_bytes(peak)
    except Exception:
        return 0.0, 0.0


def _proc_vram_smi(pids: set[int]) -> float:
    """nvidia-smi 查询计算进程显存（MiB）。WDDM 下多为 N/A，跳过。"""
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,used_memory",
                "--format=csv,noheader,nounits",
            ],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2.0,
        )
        used = 0.0
        for line in out.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2:
                continue
            raw = parts[1].replace("[", "").replace("]", "").strip()
            if not raw or raw.upper() in ("N/A", "NA", "[N/A]"):
                continue
            try:
                pid = int(parts[0])
                mib = float(raw)
            except Exception:
                continue
            if pid in pids:
                used += _valid_bytes(mib * 1024 * 1024)
        return used
    except Exception:
        return 0.0


def _proc_vram() -> tuple[float, float]:
    """
    ComfyUI 进程显存（字节）：当前、峰值候选。
    Windows 优先 PDH Dedicated；再取 NVML / torch / nvidia-smi 最大值。
    """
    pids = _comfy_pids()
    torch_cur, torch_peak = _proc_vram_torch()
    candidates = [
        _proc_vram_windows(pids),
        _proc_vram_nvml(pids),
        torch_cur,
    ]
    # nvidia-smi 仅在其它路都为 0 时兜底，避免每秒拉起进程
    cur = float(max(candidates) if candidates else 0.0)
    if cur <= 0.0:
        cur = _proc_vram_smi(pids)
    peak_hint = max(cur, torch_peak)
    return cur, peak_hint


def _cpu_name() -> str:
    try:
        import platform
        name = platform.processor() or ""
        if name and name.strip() and name.strip() not in ("x86_64", "AMD64", ""):
            return name.strip()
    except Exception:
        pass
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if line.lower().startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except Exception:
        pass
    try:
        import psutil
        n = psutil.cpu_count(logical=True) or 0
        if n:
            return f"{n} 逻辑核心"
    except Exception:
        pass
    return "CPU"


def _cpu_name_windows() -> str:
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        )
        val, _ = winreg.QueryValueEx(key, "ProcessorNameString")
        winreg.CloseKey(key)
        return str(val).strip()
    except Exception:
        return ""


def _note_peaks(sys_used: float, proc_used: float, v_used: float, pv_used: float, pv_hint: float) -> None:
    _peaks["sys_ram_used"] = max(_peaks["sys_ram_used"], sys_used)
    _peaks["proc_ram_used"] = max(_peaks["proc_ram_used"], proc_used)
    _peaks["sys_vram_used"] = max(_peaks["sys_vram_used"], v_used)
    _peaks["proc_vram_used"] = max(_peaks["proc_vram_used"], pv_used, pv_hint)


def _sample_raw(heavy_smi: bool = False) -> dict[str, Any]:
    """采集原始字节。heavy_smi=False 时不拉 nvidia-smi 进程列表（后台采样用）。"""
    pids = _comfy_pids()
    sys_total, sys_used, sys_pct = _sys_ram()
    proc_used, _ = _proc_ram_pair(_comfy_runtime_pids())
    if sys_used > 0.0 and proc_used > sys_used:
        proc_used = sys_used
    v_total, v_used, v_pct, gpu_name = _sys_vram(allow_smi=heavy_smi)

    torch_cur, torch_peak = _proc_vram_torch()
    win_v = _proc_vram_windows(pids)
    nvml_v = _proc_vram_nvml(pids)
    pv_used = max(win_v, nvml_v, torch_cur)
    if pv_used <= 0.0 and heavy_smi:
        pv_used = _proc_vram_smi(pids)
    # Comfy 显存不应明显超过本机已用
    if v_used > 0 and pv_used > v_used * 1.05:
        pv_used = v_used
    return {
        "sys_total": sys_total,
        "sys_used": sys_used,
        "sys_pct": sys_pct,
        "proc_used": proc_used,
        "v_total": v_total,
        "v_used": v_used,
        "v_pct": v_pct,
        "gpu_name": gpu_name,
        "pv_used": pv_used,
        "pv_hint": torch_peak,
    }


def _sampler_loop() -> None:
    """200ms 采样峰值，避免 1s 轮询漏掉尖峰。"""
    while True:
        try:
            with _lock:
                raw = _sample_raw(heavy_smi=False)
                _note_peaks(
                    raw["sys_used"],
                    raw["proc_used"],
                    raw["v_used"],
                    raw["pv_used"],
                    raw["pv_hint"],
                )
        except Exception:
            pass
        time.sleep(0.2)


def _ensure_sampler() -> None:
    global _sampler_started
    with _lock:
        if _sampler_started:
            return
        _sampler_started = True
    t = threading.Thread(target=_sampler_loop, name="lazy-res-sampler", daemon=True)
    t.start()


def collect_stats() -> dict[str, Any]:
    _ensure_sampler()
    proc = _get_process()
    with _lock:
        raw = _sample_raw(heavy_smi=True)
        _note_peaks(
            raw["sys_used"],
            raw["proc_used"],
            raw["v_used"],
            raw["pv_used"],
            raw["pv_hint"],
        )
        peaks_snap = dict(_peaks)

    sys_total = raw["sys_total"]
    sys_used = raw["sys_used"]
    sys_pct = raw["sys_pct"]
    proc_used = raw["proc_used"]
    if proc_used <= 0.0:
        proc_used = _proc_ram(proc)
    # 进程物理占用不可能大于整机正在使用的物理内存。
    if sys_used > 0.0 and proc_used > sys_used:
        proc_used = sys_used
    v_total = raw["v_total"]
    v_used = raw["v_used"]
    v_pct = raw["v_pct"]
    gpu_name = raw["gpu_name"]
    pv_used = raw["pv_used"]
    proc_pct = (proc_used / sys_total * 100.0) if sys_total > 0 else 0.0
    pv_pct = (pv_used / v_total * 100.0) if v_total > 0 else 0.0

    def peak_pct(used_peak: float, total: float) -> float:
        return (used_peak / total * 100.0) if total > 0 else 0.0

    cpu = _cpu_name_windows() or _cpu_name()

    return {
        "ok": True,
        "ts": time.time(),
        "gpu_name": gpu_name,
        "cpu_name": cpu,
        "sys_ram": {
            "total_gb": _bytes_to_gb(sys_total),
            "used_gb": _bytes_to_gb(sys_used),
            "percent": round(sys_pct, 1),
            "peak_gb": _bytes_to_gb(peaks_snap["sys_ram_used"]),
            "peak_percent": round(peak_pct(peaks_snap["sys_ram_used"], sys_total), 1),
        },
        "proc_ram": {
            "used_gb": _bytes_to_gb(proc_used),
            "percent": round(proc_pct, 1),
            "peak_gb": _bytes_to_gb(peaks_snap["proc_ram_used"]),
            "peak_percent": round(peak_pct(peaks_snap["proc_ram_used"], sys_total), 1),
            "total_gb": _bytes_to_gb(sys_total),
        },
        "sys_vram": {
            "total_gb": _bytes_to_gb(v_total),
            "used_gb": _bytes_to_gb(v_used),
            "percent": round(v_pct, 1),
            "peak_gb": _bytes_to_gb(peaks_snap["sys_vram_used"]),
            "peak_percent": round(peak_pct(peaks_snap["sys_vram_used"], v_total), 1),
        },
        "proc_vram": {
            "used_gb": _bytes_to_gb(pv_used),
            "percent": round(pv_pct, 1),
            "peak_gb": _bytes_to_gb(peaks_snap["proc_vram_used"]),
            "peak_percent": round(peak_pct(peaks_snap["proc_vram_used"], v_total), 1),
            "total_gb": _bytes_to_gb(v_total),
        },
    }


def reset_peaks() -> None:
    with _lock:
        for k in _peaks:
            _peaks[k] = 0.0
    try:
        import torch

        if torch.cuda.is_available():
            for i in range(torch.cuda.device_count()):
                try:
                    torch.cuda.reset_peak_memory_stats(i)
                except Exception:
                    pass
    except Exception:
        pass


def free_memory_and_cache() -> dict[str, Any]:
    """
    仅清理本 ComfyUI 进程：卸载模型 + 清空缓存。
    不关软件、不杀进程。
    """
    import gc
    import logging

    log = logging.getLogger(__name__)
    steps: list[str] = []
    errors: list[str] = []

    # 1) Comfy 模型卸载与缓存
    try:
        import comfy.model_management as mm

        if hasattr(mm, "unload_all_models"):
            mm.unload_all_models()
            steps.append("unload_all_models")
        if hasattr(mm, "cleanup_models"):
            try:
                mm.cleanup_models()
                steps.append("cleanup_models")
            except TypeError:
                try:
                    mm.cleanup_models(keep_clone_weights=False)
                    steps.append("cleanup_models")
                except Exception as e:
                    errors.append(f"cleanup_models: {e}")
            except Exception as e:
                errors.append(f"cleanup_models: {e}")
        if hasattr(mm, "soft_empty_cache"):
            try:
                mm.soft_empty_cache(True)
            except TypeError:
                mm.soft_empty_cache()
            steps.append("soft_empty_cache")
    except Exception as e:
        errors.append(f"model_management: {e}")
        log.warning("[Lazy资源] model_management 清理失败: %s", e)

    # 2) CUDA 缓存（Comfy 占用的显存碎片）
    try:
        import torch

        if torch.cuda.is_available():
            try:
                torch.cuda.synchronize()
            except Exception:
                pass
            for i in range(torch.cuda.device_count()):
                try:
                    with torch.cuda.device(i):
                        torch.cuda.empty_cache()
                        if hasattr(torch.cuda, "ipc_collect"):
                            torch.cuda.ipc_collect()
                except Exception as e:
                    errors.append(f"cuda[{i}]: {e}")
            steps.append("cuda.empty_cache")
    except Exception as e:
        errors.append(f"torch: {e}")

    # 3) Python GC
    try:
        for _ in range(3):
            gc.collect()
        steps.append("gc")
    except Exception as e:
        errors.append(f"gc: {e}")

    after = None
    try:
        after = collect_stats()
    except Exception:
        pass

    log.info("[Lazy资源] Comfy 清理完成 steps=%s err=%s", steps, errors or "无")
    return {
        "ok": True,
        "steps": steps,
        "errors": errors,
        "stats": after,
        "message": "已清理 ComfyUI 内存与缓存",
    }


def _try_register_route(method: str, path: str, fn) -> bool:
    """与 wan_director 相同：method 用小写 get/post。"""
    key = (method, path)
    if key in _registered_routes:
        return True
    try:
        from server import PromptServer

        server = getattr(PromptServer, "instance", None)
        if server is not None and hasattr(server, "routes"):
            getattr(server.routes, method)(path)(fn)
            _registered_routes.add(key)
            return True
    except Exception as e:
        try:
            import logging
            logging.getLogger(__name__).warning(
                "[Lazy资源] 注册路由失败 %s %s: %s", method, path, e
            )
        except Exception:
            pass
    return False


def ensure_resource_monitor_routes() -> None:
    """补挂未成功的路由（可重复调用）。"""
    global _pending_routes
    try:
        _ensure_sampler()
    except Exception:
        pass
    still = []
    for method, path, fn in _pending_routes:
        if not _try_register_route(method, path, fn):
            still.append((method, path, fn))
    _pending_routes = still


def _safe_route(method: str, path: str):
    def deco(fn):
        if not _try_register_route(method, path, fn):
            _pending_routes.append((method, path, fn))
        return fn

    return deco


# —— 路由定义（与 stats 一致用 GET，避免部分环境下 POST 405）——
from aiohttp import web  # noqa: E402


@_safe_route("get", "/lazy_wan_remix/resource_stats")
async def lazy_resource_stats(request):
    try:
        data = collect_stats()
        return web.json_response(data)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@_safe_route("get", "/lazy_wan_remix/resource_peaks_reset")
@_safe_route("post", "/lazy_wan_remix/resource_peaks_reset")
async def lazy_resource_peaks_reset(request):
    try:
        reset_peaks()
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@_safe_route("get", "/lazy_wan_remix/resource_free")
@_safe_route("post", "/lazy_wan_remix/resource_free")
@_safe_route("get", "/lazy_resource_free")
async def lazy_resource_free(request):
    """清理 ComfyUI 内存/显存缓存。GET/POST 均可。"""
    try:
        import asyncio

        data = await asyncio.get_event_loop().run_in_executor(
            None, free_memory_and_cache
        )
        return web.json_response(data)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@_safe_route("get", "/lazy_krea/styles")
async def lazy_krea_styles(request):
    """列出某个风格库 JSON 内的风格条目（含本包本地样图 URL）。"""
    try:
        from .lazy_krea_styles import load_style_meta, resolve_thumbnail_url

        name = ""
        try:
            name = request.rel_url.query.get("name") or ""
        except Exception:
            name = ""
        items = []
        if name and name != "none":
            for d in load_style_meta(str(name)):
                thumb = resolve_thumbnail_url(d.get("thumbnail") or "", d.get("name") or "")
                items.append({
                    "name": str(d.get("name") or ""),
                    "name_cn": str(d.get("name_cn") or d.get("name") or ""),
                    "prompt": str(d.get("prompt") or ""),
                    "negative_prompt": str(d.get("negative_prompt") or ""),
                    "thumbnail": thumb,
                    "channel": str(d.get("channel") or ""),
                })
        return web.json_response({"ok": True, "items": items})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e), "items": []}, status=500)


@_safe_route("get", "/lazy_krea/styles/image")
async def lazy_krea_styles_image(request):
    """本包 styles/samples 本地预览图。"""
    try:
        import os as _os
        from .lazy_krea_styles import samples_dir
        from .lazy_user_store import krea_samples_dir, merge_samples_dir

        fname = ""
        try:
            fname = request.rel_url.query.get("file") or ""
        except Exception:
            fname = ""
        fname = str(fname).replace("\\", "/").lstrip("/")
        if not fname or ".." in fname.split("/"):
            return web.Response(status=400, text="bad file")
        pkg_samples = _os.path.join(_os.path.dirname(__file__), "styles", "samples")
        path = ""
        for base in (merge_samples_dir(), krea_samples_dir(), samples_dir(), pkg_samples):
            if not base:
                continue
            cand = _os.path.join(base, fname)
            if _os.path.isfile(cand):
                path = cand
                break
        if not path:
            return web.Response(status=404, text="not found")
        return web.FileResponse(path)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


def _user_style_payload(item: dict) -> dict:
    from .lazy_krea_styles import resolve_thumbnail_url

    ch = str(item.get("channel") or "")
    return {
        "name": str(item.get("name") or ""),
        "prompt": str(item.get("prompt") or ""),
        "thumbnail": resolve_thumbnail_url(item.get("thumbnail") or "", item.get("name") or ""),
        "channel": ch,
        "model": "K2" if ch == "krea" else "Qwen",
        "custom": True,
    }


def _no_store(resp):
    resp.headers["Cache-Control"] = "no-store"
    return resp


async def _user_style_list_response():
    from .lazy_krea_styles import load_user_styles

    items = [_user_style_payload(d) for d in load_user_styles()]
    return _no_store(web.json_response({"ok": True, "items": items}))


@_safe_route("get", "/lazy_zidingyi/ensure")
@_safe_route("post", "/lazy_zidingyi/ensure")
async def lazy_zidingyi_ensure(request):
    """点自定义时调用。没有外部目录就新建。"""
    try:
        from .lazy_user_store import ensure_user_store

        root = ensure_user_store()
        return _no_store(web.json_response({"ok": True, "path": root}))
    except Exception as e:
        return _no_store(web.json_response({"ok": False, "error": str(e)}, status=500))


@_safe_route("get", "/lazy_merge/user_style_list")
async def lazy_merge_user_style_list(request):
    """合并台自定义风格列表。单独路径，避免和保存接口撞车。"""
    try:
        return await _user_style_list_response()
    except Exception as e:
        return _no_store(web.json_response({"ok": False, "error": str(e), "items": []}, status=500))


@_safe_route("get", "/lazy_merge/user_styles")
async def lazy_merge_user_styles_get(request):
    """兼容旧地址。"""
    try:
        return await _user_style_list_response()
    except Exception as e:
        return _no_store(web.json_response({"ok": False, "error": str(e), "items": []}, status=500))


@_safe_route("post", "/lazy_merge/user_styles")
async def lazy_merge_user_styles_post(request):
    """保存或删除自定义风格。"""
    try:
        import base64

        from .lazy_krea_styles import remove_user_style, save_user_style

        try:
            data = await request.json()
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        action = str(data.get("action") or "save").strip().lower()
        if request.method.upper() == "GET":
            return await _user_style_list_response()
        if action == "delete":
            remove_user_style(str(data.get("name") or ""))
            return _no_store(web.json_response({"ok": True}))
        raw = str(data.get("image_b64") or "")
        image_bytes = None
        if raw.strip():
            if "," in raw[:80]:
                raw = raw.split(",", 1)[1]
            try:
                image_bytes = base64.b64decode(raw, validate=False)
            except Exception:
                return web.json_response({"ok": False, "error": "预览图无效"}, status=400)
            if not image_bytes:
                image_bytes = None
        item = save_user_style(
            name=str(data.get("name") or ""),
            prompt=str(data.get("prompt") or ""),
            channel=str(data.get("model") or data.get("channel") or ""),
            old_name=str(data.get("old_name") or ""),
            image_bytes=image_bytes,
        )
        return _no_store(web.json_response({"ok": True, "item": _user_style_payload(item)}))
    except ValueError as e:
        return _no_store(web.json_response({"ok": False, "error": str(e)}, status=400))
    except Exception as e:
        return _no_store(web.json_response({"ok": False, "error": str(e)}, status=500))
