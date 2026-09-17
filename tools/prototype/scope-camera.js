const ASPECT = 420 / 228;
export const IMPACT_HOLD_MS = 1400;

export function sampleFlightTrack(track, tick) {
  const local = tick - track.start, points = track.leg.pts;
  if (local < 0 || local > track.duration || points.length === 0) return null;
  const sample = Math.min(local, points.length - 1), upto = Math.floor(sample);
  const next = Math.min(upto + 1, points.length - 1), blend = sample - upto;
  return { x: points[upto].x + (points[next].x - points[upto].x) * blend,
    y: points[upto].y + (points[next].y - points[upto].y) * blend, upto, blend };
}

function framePoints(points, minimumWidth, padding, mapWidth, mapHeight) {
  const leftEdge = Math.min(...points.map((point) => point.x));
  const rightEdge = Math.max(...points.map((point) => point.x));
  const topEdge = Math.min(...points.map((point) => point.y));
  const bottomEdge = Math.max(...points.map((point) => point.y));
  const width = Math.min(mapWidth, mapHeight * ASPECT,
    Math.max(minimumWidth, rightEdge - leftEdge + padding * 2, (bottomEdge - topEdge + padding * 2) * ASPECT));
  const height = width / ASPECT;
  const outside = leftEdge < 0 || topEdge < 0 || rightEdge > mapWidth || bottomEdge > mapHeight;
  const centerX = (leftEdge + rightEdge) / 2, centerY = (topEdge + bottomEdge) / 2;
  const left = outside ? centerX - width / 2 : Math.max(0, Math.min(mapWidth - width, centerX - width / 2));
  const top = outside ? centerY - height / 2 : Math.max(0, Math.min(mapHeight - height, centerY - height / 2));
  return { left, top, width, height, outside };
}

export function scopeCamera({ player, phase, tracks, tick, impacts, impactAt, now, cell, mapWidth, mapHeight, reducedMotion = false }) {
  if (!player) return null;
  if (phase === "RESOLVE") {
    const projectiles = [];
    for (const track of tracks) {
      const sample = sampleFlightTrack(track, tick);
      if (sample) projectiles.push({ x: sample.x / cell, y: sample.y / cell, slot: track.leg.slot });
    }
    if (projectiles.length) return { ...framePoints(projectiles, 105, 18, mapWidth, mapHeight),
      mode: "flight", slot: projectiles[0].slot, projectiles, count: projectiles.length };
  }
  const nuclear = phase !== "RESOLVE" && impacts.some((impact) => impact.weapon.id === 7);
  const hold = nuclear ? nuclearCloudDuration(reducedMotion) : IMPACT_HOLD_MS;
  const watchingImpact = phase !== "RESOLVE" && tracks.length > 0 && impactAt > 0
    && (phase === "IMPACT" || phase === "SETTLE" || (now >= impactAt && now - impactAt < hold));
  if (watchingImpact) {
    const points = [];
    for (const impact of impacts) {
      const radius = Math.max(10, impact.weapon.carveCells || impact.weapon.depositCells || 12);
      const horizontal = impact.x / cell, vertical = impact.y / cell;
      points.push({ x: horizontal - radius, y: vertical - radius }, { x: horizontal + radius, y: vertical + radius });
      if (impact.weapon.id === 7) {
        const bounds = nuclearCloudBounds({ x: horizontal, y: vertical, size: radius });
        points.push({ x: bounds.left, y: bounds.top }, { x: bounds.right, y: bounds.bottom });
      }
    }
    if (!points.length) {
      for (const track of tracks) {
        const point = track.leg.pts.at(-1);
        if (point) points.push({ x: point.x / cell, y: point.y / cell });
      }
    }
    if (points.length) return { ...framePoints(points, 105, 12, mapWidth, mapHeight),
      mode: impacts.length ? "impact" : "exit", slot: tracks[0].leg.slot, projectiles: [], count: impacts.length };
  }
  return { ...framePoints([{ x: player.x / cell, y: player.y / cell - 7.75 }], 52.5, 0, mapWidth, mapHeight),
    mode: "aim", slot: player.slot, projectiles: [], count: 0 };
}
import { nuclearCloudBounds, nuclearCloudDuration } from "./nuclear-art.js";
