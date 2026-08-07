"""룸 스냅샷을 별도 프로세스에서 권위 시뮬레이션한다."""

from __future__ import annotations

import asyncio
import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np

from talus.sim import match as Match
from talus.sim import terrain as T
from talus.sim import trig

_LOADED_TRIG_PATH: str | None = None


def _ensure_trig(path: str) -> None:
    global _LOADED_TRIG_PATH
    if _LOADED_TRIG_PATH == path and trig.is_loaded():
        return
    trig.load_trig(Path(path).read_bytes())
    _LOADED_TRIG_PATH = path


def _restore_grid(grid_bytes: bytes) -> None:
    source = np.frombuffer(grid_bytes, dtype=np.uint8)
    if source.size != T.N:
        raise ValueError(f"grid length must be {T.N}")
    T.grid[:] = source
    T.clear_active()
    T.set_step(0)
    T.reset_gate_cache()


def _settle_wire(result: Match.SettleResult) -> dict[str, object]:
    return {
        "steps": result.steps,
        "connectivityRounds": result.connectivity_rounds,
        "forced": result.forced,
    }


def _outcome_wire(outcome: Match.RoundOutcome) -> dict[str, object]:
    if not outcome.over:
        return {"over": False}
    return {"over": True, "reason": outcome.reason, "winner": outcome.winner}


def _create_match_worker(
    map_seed: int,
    specs: list[tuple[str, bool]],
    trig_path: str,
) -> tuple[Match.MatchState, bytes, dict[str, object], int]:
    _ensure_trig(trig_path)
    made = Match.create_match(
        map_seed,
        [Match.PlayerSpec(name=name, is_ai=is_ai) for name, is_ai in specs],
    )
    return made.state, T.grid.tobytes(), _settle_wire(made.initial_settle), T.checksum()


def _resolve_turn_worker(
    state: Match.MatchState,
    grid_bytes: bytes,
    intent_wire: dict[str, object],
    trig_path: str,
) -> tuple[Match.MatchState, bytes, dict[str, Any]]:
    _ensure_trig(trig_path)
    _restore_grid(grid_bytes)
    intent = Match.Intent(
        angle10=intent_wire["angle10"],
        power=intent_wire["power"],
        weapon_id=intent_wire["weaponId"],
        move_dx=intent_wire["moveDx"],
        use_shield=intent_wire["useShield"],
    )
    result = Match.resolve_match_turn(state, intent)
    wire: dict[str, Any] = {
        "turnNo": result.turn_no,
        "turnSeed": result.turn_seed,
        "wind": result.wind,
        "events": result.events,
        "removed": result.removed,
        "filled": result.filled,
        "conv": result.conv,
        "settle": _settle_wire(result.settle),
        "lastBlastOwner": result.last_blast_owner,
        "outcome": _outcome_wire(result.outcome),
        "roundEvents": result.round_events,
        "checksum": result.checksum,
        "mass": result.mass,
    }
    return state, T.grid.tobytes(), wire


def _start_next_round_worker(
    state: Match.MatchState,
    grid_bytes: bytes,
    trig_path: str,
) -> tuple[Match.MatchState, bytes, int]:
    _ensure_trig(trig_path)
    _restore_grid(grid_bytes)
    Match.start_next_round(state)
    return state, T.grid.tobytes(), T.checksum()


class SimulationPool:
    def __init__(self, trig_path: Path, workers: int = 2) -> None:
        self._trig_path = str(trig_path)
        self._pool = ProcessPoolExecutor(
            max_workers=max(1, workers),
            mp_context=multiprocessing.get_context("spawn"),
        )

    async def create_match(
        self,
        map_seed: int,
        specs: list[tuple[str, bool]],
    ) -> tuple[Match.MatchState, bytes, dict[str, object], int]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._pool,
            _create_match_worker,
            map_seed,
            specs,
            self._trig_path,
        )

    async def resolve_turn(
        self,
        state: Match.MatchState,
        grid_bytes: bytes,
        intent_wire: dict[str, object],
    ) -> tuple[Match.MatchState, bytes, dict[str, Any]]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._pool,
            _resolve_turn_worker,
            state,
            grid_bytes,
            intent_wire,
            self._trig_path,
        )

    async def start_next_round(
        self,
        state: Match.MatchState,
        grid_bytes: bytes,
    ) -> tuple[Match.MatchState, bytes, int]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._pool,
            _start_next_round_worker,
            state,
            grid_bytes,
            self._trig_path,
        )

    async def close(self) -> None:
        await asyncio.to_thread(self._pool.shutdown, True, cancel_futures=True)
