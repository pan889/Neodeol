/** 라운드·턴·경제·승패 — docs/match.md 의 TypeScript 기준 구현. */

import { clampInt, floorDiv, hash32 } from "./intmath.ts";
import * as T from "./terrain.ts";
import * as B from "./ballistics.ts";
import * as Wp from "./weapons.ts";
import * as M from "./mapgen.ts";

export const MATCH_VERSION = 5;
export const AMMO_INFINITE = 0x7fffffff;

export const RULES = {
  rounds: 5,
  roundTurnCap: 40,
  startGold: 1500,
  goldPerDamage: 8,
  goldPerKill: 400,
  goldSurvive: 300,
  goldLastPlaceBonus: 250,
  killScore: 100,
  damageScore: 1,
  surviveScore: 50,
  fuelCellsPerUnit: 14,
  moveMaxStepUp: 6,
  maxSettleSteps: 12000,
  connectivityMaxRounds: 8,
} as const;

export type MatchPhase = "aim" | "shop" | "done";

export interface Intent {
  angle10: number;
  power: number;
  weaponId: number;
  moveDx: number;
  useShield: boolean;
}

export interface ItemCounts {
  shield: number;
  parachute: number;
  fuel: number;
  anemo: number;
}

export interface Player extends B.Tank {
  isAI: boolean;
  gold: number;
  weaponId: number;
  ammo: number[];
  items: ItemCounts;
  score: number;
  kills: number;
  damageDone: number;
  intent: Intent | null;
  shieldUp: boolean;
}

export interface PlayerSpec {
  name: string;
  isAI?: boolean;
}

export interface MatchEvent {
  t: string;
  slot?: number;
  cells?: number;
  weaponId?: number;
  angle10?: number;
  power?: number;
  by?: number | null;
  dmg?: number;
  distPx?: number;
  fallPx?: number;
  pct?: number;
}

export interface OwnedLeg extends Wp.Leg {
  slot: number;
}

export interface OwnedDetonation extends Wp.Detonation {
  owner: number;
}

export interface ResolveTurnResult {
  legs: OwnedLeg[];
  dets: OwnedDetonation[];
  events: MatchEvent[];
}

export interface ApplyDetonationsResult {
  events: MatchEvent[];
  removed: number;
  filled: number;
  conv: number;
}

export interface SettleResult {
  steps: number;
  connectivityRounds: number;
  forced: boolean;
}

export type RoundReason = "last" | "wipe" | "turncap";

export interface RoundOutcome {
  over: boolean;
  reason?: RoundReason;
  winner?: number | null;
}

export interface MatchState {
  mapSeed: number;
  roundNo: number;
  turnNo: number;
  roundTurn: number;
  activeSlot: number;
  wind: number;
  spawnCells: number[];
  players: Player[];
  phase: MatchPhase;
  over: boolean;
}

export interface CreateMatchResult {
  state: MatchState;
  initialSettle: SettleResult;
}

export interface MatchTurnResult {
  turnNo: number;
  turnSeed: number;
  wind: number;
  legs: OwnedLeg[];
  dets: OwnedDetonation[];
  events: MatchEvent[];
  removed: number;
  filled: number;
  conv: number;
  settle: SettleResult;
  lastBlastOwner: number | null;
  outcome: RoundOutcome;
  roundEvents: MatchEvent[];
  checksum: number;
  mass: number;
}

function assertPlayers(players: Player[]): void {
  if (players.length < 2 || players.length > 6) throw new RangeError("players length must be 2..6");
  for (let i = 0; i < players.length; i++) {
    if (players[i].slot !== i) throw new RangeError("players must be contiguous slot order");
  }
}

function isInt(value: number): boolean {
  return Number.isInteger(value);
}

export function makePlayer(slot: number, name: string, isAI: boolean, xSub: number): Player {
  const tank = B.makeTank(slot, xSub, name);
  const ammo = new Array<number>(Wp.WEAPONS.length).fill(0);
  for (const weapon of Wp.WEAPONS) ammo[weapon.id] = weapon.ammo0 === null ? -1 : weapon.ammo0;
  return {
    ...tank,
    isAI,
    gold: RULES.startGold,
    weaponId: 0,
    ammo,
    items: { shield: 0, parachute: 0, fuel: 0, anemo: 0 },
    score: 0,
    kills: 0,
    damageDone: 0,
    intent: null,
    shieldUp: false,
  };
}

export function ammoOf(player: Player, weaponId: number): number {
  const weapon = Wp.byId(weaponId);
  if (weapon.ammo0 === null) return AMMO_INFINITE;
  const amount = player.ammo[weapon.id];
  return amount === undefined || amount < 0 ? 0 : amount;
}

export function canFire(player: Player, weaponId: number): boolean {
  return ammoOf(player, weaponId) > 0;
}

function spendAmmo(player: Player, weaponId: number): void {
  const weapon = Wp.byId(weaponId);
  if (weapon.ammo0 === null) return;
  const amount = player.ammo[weapon.id] ?? 0;
  player.ammo[weapon.id] = amount > 0 ? amount - 1 : 0;
}

export function effectiveWeapon(player: Player, weaponId: number): Wp.Weapon {
  if (isInt(weaponId) && weaponId >= 0 && weaponId < Wp.WEAPONS.length && canFire(player, weaponId)) {
    return Wp.byId(weaponId);
  }
  return Wp.byId(0);
}

export function normalizeIntent(player: Player, candidate: Intent | null): Intent {
  const angle10 = candidate !== null && isInt(candidate.angle10) && candidate.angle10 >= 0 && candidate.angle10 <= 1800
    ? candidate.angle10
    : player.angle10;
  const power = candidate !== null && isInt(candidate.power) && candidate.power >= 0 && candidate.power <= 1000
    ? candidate.power
    : player.power;
  let fallbackWeapon = player.weaponId;
  if (!canFire(player, fallbackWeapon)) fallbackWeapon = 0;
  const weaponId = candidate !== null
    && isInt(candidate.weaponId)
    && candidate.weaponId >= 0
    && candidate.weaponId < Wp.WEAPONS.length
    && canFire(player, candidate.weaponId)
    ? candidate.weaponId
    : fallbackWeapon;
  const moveDx = candidate !== null && isInt(candidate.moveDx)
    ? clampInt(candidate.moveDx, -T.W, T.W)
    : 0;
  const useShield = candidate !== null && candidate.useShield === true;
  return { angle10, power, weaponId, moveDx, useShield };
}

export function setIntent(player: Player, candidate: Intent | null): Intent {
  const intent = normalizeIntent(player, candidate);
  player.angle10 = intent.angle10;
  player.power = intent.power;
  player.weaponId = intent.weaponId;
  player.intent = intent;
  return intent;
}

export function applyMove(player: Player, dxCells: number): number {
  if (!player.alive || dxCells === 0) return 0;
  const budget = player.items.fuel * RULES.fuelCellsPerUnit;
  let wanted = dxCells < 0 ? -dxCells : dxCells;
  if (wanted > budget) wanted = budget;
  const direction = dxCells < 0 ? -1 : 1;
  let moved = 0;
  for (let i = 0; i < wanted; i++) {
    const nextX = player.x + direction * B.CELL_SUBPX;
    if (nextX < 0 || nextX >= B.MAP_W_SUB) break;
    const currentTop = B.surfaceSubY(player.x);
    const nextTop = B.surfaceSubY(nextX);
    if (currentTop - nextTop > RULES.moveMaxStepUp * B.CELL_SUBPX) break;
    player.x = nextX;
    moved++;
  }
  if (moved > 0) {
    const used = floorDiv(moved + RULES.fuelCellsPerUnit - 1, RULES.fuelCellsPerUnit);
    player.items.fuel = player.items.fuel > used ? player.items.fuel - used : 0;
    B.reseatTank(player);
  }
  return moved;
}

export function resolveTurn(players: Player[], wind: number): ResolveTurnResult {
  assertPlayers(players);
  const legs: OwnedLeg[] = [];
  const dets: OwnedDetonation[] = [];
  const events: MatchEvent[] = [];

  for (const player of players) {
    if (!player.alive || player.intent === null) continue;
    const moved = applyMove(player, player.intent.moveDx);
    if (moved > 0) events.push({ t: "move", slot: player.slot, cells: moved });
    player.shieldUp = player.intent.useShield && player.items.shield > 0;
    if (player.shieldUp) {
      player.items.shield--;
      events.push({ t: "shield", slot: player.slot });
    }
  }

  for (const player of players) {
    if (!player.alive || player.intent === null) continue;
    const weapon = effectiveWeapon(player, player.intent.weaponId);
    player.weaponId = weapon.id;
    spendAmmo(player, weapon.id);
    const pose = B.shotPose(player, player.intent.angle10);
    const plan = Wp.resolveShot(
      pose.x,
      pose.y,
      pose.angle10,
      player.intent.power,
      wind,
      player.slot,
      players,
      weapon,
    );
    for (const leg of plan.legs) legs.push({ ...leg, slot: player.slot });
    for (const det of plan.dets) dets.push({ ...det, owner: player.slot });
    events.push({
      t: "fire",
      slot: player.slot,
      weaponId: weapon.id,
      angle10: player.intent.angle10,
      power: player.intent.power,
    });
  }
  return { legs, dets, events };
}

interface PendingDamage {
  idx: number;
  dmg: number;
  dist: number;
  owner: number;
}

function creditDamage(players: Player[], ownerSlot: number | null, damage: number): void {
  if (ownerSlot === null) return;
  const owner = players[ownerSlot];
  if (owner === undefined || owner.slot !== ownerSlot) return;
  owner.damageDone += damage;
  owner.gold += damage * RULES.goldPerDamage;
}

function creditKill(players: Player[], ownerSlot: number | null, victimSlot: number): void {
  if (ownerSlot === null || ownerSlot === victimSlot) return;
  const owner = players[ownerSlot];
  if (owner === undefined || owner.slot !== ownerSlot) return;
  owner.kills++;
  owner.gold += RULES.goldPerKill;
}

export function applyDetonations(players: Player[], source: OwnedDetonation[]): ApplyDetonationsResult {
  assertPlayers(players);
  const dets = source.slice().sort((a, b) => a.owner - b.owner);
  const events: MatchEvent[] = [];
  const pending: PendingDamage[] = [];

  for (const det of dets) {
    if (det.weapon.maxDamage <= 0) continue;
    for (const hit of B.computeDamage(det.x, det.y, det.weapon, players)) {
      pending.push({ idx: hit.idx, dmg: hit.dmg, dist: hit.dist, owner: det.owner });
    }
  }

  let removed = 0;
  let filled = 0;
  for (const det of dets) {
    const applied = Wp.applyDetonation(det);
    removed += applied.removed;
    filled += applied.filled;
  }
  const conv = T.connectivity();
  if (conv > 0) events.push({ t: "conv", cells: conv });

  for (const damage of pending) {
    const player = players[damage.idx];
    if (!player.alive) continue;
    if (player.shieldUp) {
      player.shieldUp = false;
      events.push({ t: "blocked", slot: player.slot });
      continue;
    }
    player.hp -= damage.dmg;
    creditDamage(players, damage.owner, damage.dmg);
    events.push({
      t: "damage",
      slot: player.slot,
      dmg: damage.dmg,
      by: damage.owner,
      distPx: damage.dist >> B.PX_SHIFT,
    });
  }
  return { events, removed, filled, conv };
}

export function settleTerrain(
  maxSteps: number = RULES.maxSettleSteps,
  maxConnectivityRounds: number = RULES.connectivityMaxRounds,
): SettleResult {
  T.setStep(0);
  let steps = 0;
  let connectivityRounds = 0;
  while (steps < maxSteps) {
    steps++;
    if (T.step().mobile !== 0) continue;
    const converted = T.connectivity();
    if (converted === 0) return { steps, connectivityRounds, forced: false };
    connectivityRounds++;
    if (connectivityRounds >= maxConnectivityRounds) {
      return forcedStop(steps, connectivityRounds);
    }
  }
  return forcedStop(steps, connectivityRounds);
}

/**
 * 강제 종료 — `terrain.md` §5.2 "종료 시점의 격자를 그대로 확정하고 활성 행 마스크를 비운다".
 *
 * **비우지 않으면 lockstep 이 깨진다.** 활성 행 마스크는 시뮬레이션 상태인데 격자
 * 스냅샷에 안 들어간다. 서버는 매 턴 격자를 바이트에서 복원하면서 마스크를 비우고
 * (`room/simulation.py` `_restore_grid`), 클라이언트는 메모리에 그대로 이어간다.
 * 정상 종료는 가동 셀이 0이라 마스크도 비어 있어 양쪽이 같지만, 강제 종료는 마스크가
 * 남아서 **다음 턴부터 두 쪽이 다른 지형을 시뮬레이션한다.** 리싱크(`fullState`)도
 * 격자만 보내므로 같은 구멍이다.
 *
 * 즉 이 한 줄이 "턴 경계에서 sim 상태는 격자 하나뿐" 이라는 불변식을 지킨다.
 */
function forcedStop(steps: number, connectivityRounds: number): SettleResult {
  T.clearActive();
  return { steps, connectivityRounds, forced: true };
}

export function applyPhase(players: Player[], lastBlastOwner: number | null): MatchEvent[] {
  assertPlayers(players);
  const events: MatchEvent[] = [];
  for (const player of players) {
    if (!player.alive) continue;
    const fall = B.reseatTank(player);
    if (fall < 0) {
      player.hp = 0;
      events.push({ t: "outofmap", slot: player.slot });
    } else if (fall > 0) {
      const damage = B.fallDamage(fall);
      if (damage > 0 && player.items.parachute > 0) {
        player.items.parachute--;
        events.push({ t: "parachute", slot: player.slot, fallPx: fall });
      } else if (damage > 0) {
        player.hp -= damage;
        creditDamage(players, lastBlastOwner, damage);
        events.push({ t: "falldamage", slot: player.slot, fallPx: fall, dmg: damage, by: lastBlastOwner });
      }
    }

    const buriedFraction = B.buriedFraction(player);
    const wasBuried = player.buried;
    player.buried = buriedFraction >= B.CFG.burialPermille;
    if (player.buried) {
      player.hp -= B.CFG.burialDamage;
      creditDamage(players, lastBlastOwner, B.CFG.burialDamage);
      events.push({
        t: "buried",
        slot: player.slot,
        pct: floorDiv(buriedFraction, 10),
        dmg: B.CFG.burialDamage,
        by: lastBlastOwner,
      });
    } else if (wasBuried) {
      events.push({ t: "unburied", slot: player.slot });
    }

    if (player.hp <= 0) {
      player.hp = 0;
      player.alive = false;
      events.push({ t: "dead", slot: player.slot, by: lastBlastOwner });
      creditKill(players, lastBlastOwner, player.slot);
    }
  }
  return events;
}

export function roundOutcome(players: Player[], roundTurn: number): RoundOutcome {
  assertPlayers(players);
  const alive = players.filter((player) => player.alive);
  if (alive.length <= 1) {
    return {
      over: true,
      reason: alive.length === 1 ? "last" : "wipe",
      winner: alive.length === 1 ? alive[0].slot : null,
    };
  }
  if (roundTurn >= RULES.roundTurnCap) {
    let bestHp = alive[0].hp;
    for (let i = 1; i < alive.length; i++) if (alive[i].hp > bestHp) bestHp = alive[i].hp;
    const leaders = alive.filter((player) => player.hp === bestHp);
    return { over: true, reason: "turncap", winner: leaders.length === 1 ? leaders[0].slot : null };
  }
  return { over: false };
}

export function closeRound(players: Player[], outcome: RoundOutcome): MatchEvent[] {
  assertPlayers(players);
  const events: MatchEvent[] = [];
  for (const player of players) {
    player.score += player.kills * RULES.killScore + player.damageDone * RULES.damageScore;
    if (player.alive && outcome.reason !== "wipe") {
      player.score += RULES.surviveScore;
      player.gold += RULES.goldSurvive;
      events.push({ t: "survive", slot: player.slot });
    }
    player.kills = 0;
    player.damageDone = 0;
  }
  const ranked = players.slice().sort((a, b) => a.score === b.score ? a.slot - b.slot : a.score - b.score);
  for (let rank = 0; rank < ranked.length; rank++) {
    const bonus = (ranked.length - 1 - rank) * RULES.goldLastPlaceBonus;
    if (bonus > 0) ranked[rank].gold += bonus;
  }
  return events;
}

export function beginRound(players: Player[], spawnCells: number[]): void {
  assertPlayers(players);
  if (spawnCells.length !== players.length) throw new RangeError("spawnCells length mismatch");
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    player.hp = B.MAX_HP;
    player.alive = true;
    player.buried = false;
    player.shieldUp = false;
    player.intent = null;
    player.x = spawnCells[i] * B.CELL_SUBPX;
    player.y = B.surfaceSubY(player.x);
    B.reseatTank(player);
  }
}

export function buyWeapon(player: Player, weaponId: number): boolean {
  if (!isInt(weaponId) || weaponId < 0 || weaponId >= Wp.WEAPONS.length) return false;
  const weapon = Wp.byId(weaponId);
  if (weapon.ammo0 === null || player.gold < weapon.price) return false;
  player.gold -= weapon.price;
  player.ammo[weapon.id] = (player.ammo[weapon.id] ?? 0) + 1;
  return true;
}

export function buyItem(player: Player, key: keyof ItemCounts): boolean {
  const item = Wp.ITEMS.find((candidate) => candidate.key === key);
  if (item === undefined || player.gold < item.price) return false;
  player.gold -= item.price;
  player.items[key]++;
  return true;
}

export function deriveTurnSeed(mapSeed: number, turnNo: number): number {
  return hash32(mapSeed, turnNo, 0, 0);
}

export function deriveWind(mapSeed: number, turnNo: number, previousWind = 0): number {
  const maxWind = B.CFG.windMax;
  if (maxWind <= 0) return 0;
  const roll = hash32(mapSeed ^ 0x5715, turnNo, previousWind, 0) % 20;
  const delta = roll === 0 ? -3 : (roll === 19 ? 3 : (roll < 8 ? -1 : (roll < 12 ? 0 : 1)));
  const candidate = previousWind + delta;
  if (candidate > maxWind) return maxWind - (candidate - maxWind);
  if (candidate < -maxWind) return -maxWind + (-maxWind - candidate);
  return clampInt(candidate, -maxWind, maxWind);
}

export function matchLeaders(players: Player[]): number[] {
  assertPlayers(players);
  let bestScore = players[0].score;
  for (let i = 1; i < players.length; i++) if (players[i].score > bestScore) bestScore = players[i].score;
  return players.filter((player) => player.score === bestScore).map((player) => player.slot);
}

export function nextAliveSlot(players: Player[], currentSlot: number): number {
  assertPlayers(players);
  if (!isInt(currentSlot) || currentSlot < 0 || currentSlot >= players.length) {
    throw new RangeError("current slot out of range");
  }
  for (let offset = 1; offset <= players.length; offset++) {
    const slot = (currentSlot + offset) % players.length;
    if (players[slot].alive) return slot;
  }
  throw new Error("no alive players");
}

export function createMatch(mapSeed: number, specs: PlayerSpec[]): CreateMatchResult {
  if (specs.length < 2 || specs.length > 6) throw new RangeError("player specs length must be 2..6");
  T.CFG.seed = mapSeed;
  T.grid.set(M.buildMap(mapSeed));
  T.connectivity();
  T.markAll();
  const initialSettle = settleTerrain();
  if (initialSettle.forced) throw new Error("initial map settlement exceeded limit");
  const spawnCells = M.chooseSpawnCells(T.grid, specs.length);
  const players = specs.map((spec, slot) => makePlayer(
    slot,
    spec.name,
    spec.isAI === true,
    spawnCells[slot] * B.CELL_SUBPX,
  ));
  beginRound(players, spawnCells);
  return {
    state: {
      mapSeed,
      roundNo: 1,
      turnNo: 0,
      roundTurn: 0,
      activeSlot: 0,
      wind: deriveWind(mapSeed, 1, 0),
      spawnCells,
      players,
      phase: "aim",
      over: false,
    },
    initialSettle,
  };
}

export function resolveMatchTurn(state: MatchState, intent: Intent | null): MatchTurnResult {
  if (state.over || state.phase !== "aim") throw new Error("match is not accepting intents");
  assertPlayers(state.players);
  if (!isInt(state.activeSlot) || state.activeSlot < 0 || state.activeSlot >= state.players.length) {
    throw new RangeError("active slot out of range");
  }
  const activePlayer = state.players[state.activeSlot];
  if (!activePlayer.alive) throw new Error("active player is not alive");
  const turnWind = state.wind;
  state.turnNo++;
  state.roundTurn++;
  const turnSeed = deriveTurnSeed(state.mapSeed, state.turnNo);
  T.CFG.seed = turnSeed;
  for (const player of state.players) player.intent = null;
  setIntent(activePlayer, intent);

  const resolved = resolveTurn(state.players, turnWind);
  const applied = applyDetonations(state.players, resolved.dets);
  const settle = settleTerrain();
  const lastBlastOwner = resolved.dets.length === 0 ? null : resolved.dets[resolved.dets.length - 1].owner;
  const phaseEvents = applyPhase(state.players, lastBlastOwner);
  const outcome = roundOutcome(state.players, state.roundTurn);
  const roundEvents = outcome.over ? closeRound(state.players, outcome) : [];
  if (outcome.over) {
    if (state.roundNo >= RULES.rounds) {
      state.over = true;
      state.phase = "done";
    } else {
      state.phase = "shop";
    }
  } else {
    state.activeSlot = nextAliveSlot(state.players, state.activeSlot);
    state.wind = deriveWind(state.mapSeed, state.turnNo + 1, turnWind);
    state.phase = "aim";
  }

  const events = [...resolved.events, ...applied.events, ...phaseEvents];
  if (settle.forced) events.push({ t: "settlecap", cells: settle.steps });
  return {
    turnNo: state.turnNo,
    turnSeed,
    wind: turnWind,
    legs: resolved.legs,
    dets: resolved.dets,
    events,
    removed: applied.removed,
    filled: applied.filled,
    conv: applied.conv,
    settle,
    lastBlastOwner,
    outcome,
    roundEvents,
    checksum: T.checksum(),
    mass: T.massCount(),
  };
}

export function startNextRound(state: MatchState): void {
  if (state.over || state.phase !== "shop") throw new Error("match is not between rounds");
  state.roundNo++;
  state.roundTurn = 0;
  state.activeSlot = (state.roundNo - 1) % state.players.length;
  state.spawnCells = M.chooseSpawnCells(T.grid, state.players.length);
  beginRound(state.players, state.spawnCells);
  state.wind = deriveWind(state.mapSeed, state.turnNo + 1, state.wind);
  state.phase = "aim";
}
