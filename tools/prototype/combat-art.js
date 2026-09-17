import { artHash } from "./battlefield-art.js";
import { sampleFlightTrack } from "./scope-camera.js";
import { drawNuclearCloud } from "./nuclear-art.js";

export const SHELL_STYLES = Object.freeze([
  { code: "HE / M01", shape: "ogive", metal: "#a5a88b", band: "#dfb967", heat: "#ffd59a", length: 7.4, radius: 1.6 },
  { code: "HEAVY / M02", shape: "heavy", metal: "#907569", band: "#d88062", heat: "#ffad6a", length: 9.2, radius: 2.25 },
  { code: "CLUSTER / M03", shape: "cluster", metal: "#879b94", band: "#91c7c2", heat: "#d3e6cb", length: 8.8, radius: 2 },
  { code: "DRILL / M04", shape: "drill", metal: "#9babb6", band: "#b6d5df", heat: "#dbeaff", length: 9.6, radius: 1.7 },
  { code: "ROLLER / M05", shape: "roller", metal: "#8a936d", band: "#c7d98d", heat: "#e6e5af", length: 6.4, radius: 2.6 },
  { code: "HEAT / M06", shape: "dart", metal: "#ba9575", band: "#edc199", heat: "#fff0cd", length: 10.4, radius: 1.2 },
  { code: "SOIL / M07", shape: "canister", metal: "#809782", band: "#c8b480", heat: "#cfbc8d", length: 7.6, radius: 2.2 },
  { code: "ATOMIC / M08", shape: "atomic", metal: "#989d83", band: "#f0ce67", heat: "#ffe6a3", length: 11.2, radius: 2.6 },
].map(Object.freeze));

export function shellStyle(weaponId) {
  return SHELL_STYLES[weaponId] || SHELL_STYLES[0];
}

function shape(context, points, fill, stroke = null, lineWidth = .35) {
  context.beginPath();
  context.moveTo(...points[0]);
  for (let index = 1; index < points.length; index++) context.lineTo(...points[index]);
  context.closePath();
  if (fill) { context.fillStyle = fill; context.fill(); }
  if (stroke) { context.strokeStyle = stroke; context.lineWidth = lineWidth; context.stroke(); }
}

function halo(context, horizontal, vertical, radius, color, opacity = 1) {
  if (radius <= 0 || opacity <= 0) return;
  context.save();
  context.globalAlpha *= opacity;
  const light = context.createRadialGradient(horizontal, vertical, 0, horizontal, vertical, radius);
  light.addColorStop(0, `${color}b0`); light.addColorStop(.25, `${color}45`); light.addColorStop(1, `${color}00`);
  context.fillStyle = light;
  context.fillRect(horizontal - radius, vertical - radius, radius * 2, radius * 2);
  context.restore();
}

export function projectilePose(track, tick, cell) {
  const sample = sampleFlightTrack(track, tick);
  if (!sample) return null;
  const points = track.leg.pts;
  let before = sample.upto, after = Math.min(before + 1, points.length - 1);
  while (before > 0 && points[before].x === points[after].x && points[before].y === points[after].y) before--;
  while (after + 1 < points.length && points[before].x === points[after].x && points[before].y === points[after].y) after++;
  return { ...sample, horizontal: sample.x / cell, vertical: sample.y / cell,
    angle: Math.atan2(points[after].y - points[before].y, points[after].x - points[before].x),
    weaponId: track.weaponId ?? 0, kind: track.leg.kind };
}

export function drawProjectile(context, options) {
  const { horizontal, vertical, angle = 0, weaponId = 0, kind = "main", now = 0,
    scale = 1, icon = false, reducedMotion = false } = options;
  const style = shellStyle(weaponId), child = kind === "split";
  const length = style.length * (child ? .6 : 1), radius = style.radius * (child ? .65 : 1);
  const rear = -length * .48, nose = length * .52;
  context.save(); context.translate(horizontal, vertical); context.rotate(angle); context.scale(scale, scale);
  if (!icon && !reducedMotion) halo(context, -1, 0, radius * 3.4, style.heat, .28);
  const metal = context.createLinearGradient(0, -radius, 0, radius);
  metal.addColorStop(0, "#fbebc4"); metal.addColorStop(.18, style.metal);
  metal.addColorStop(.47, style.metal); metal.addColorStop(.72, "#424941"); metal.addColorStop(1, "#182521");
  if (style.shape === "roller") {
    if (!reducedMotion) context.rotate(now * .008);
    context.fillStyle = metal; context.strokeStyle = "#111d19"; context.lineWidth = .4;
    context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill(); context.stroke();
    context.strokeStyle = style.band; context.lineWidth = .55;
    context.beginPath(); context.ellipse(0, 0, radius * .45, radius * .92, .3, 0, Math.PI * 2); context.stroke();
    for (let stud = 0; stud < 6; stud++) {
      const rotation = stud * Math.PI / 3;
      context.fillStyle = "#e1d5a8";
      context.beginPath(); context.arc(Math.cos(rotation) * radius * .72, Math.sin(rotation) * radius * .72, .3, 0, Math.PI * 2); context.fill();
    }
  } else {
    if (["dart", "atomic", "cluster"].includes(style.shape) || child) {
      shape(context, [[rear + 2, 0], [rear - 1.1, -radius * 1.7], [rear - .5, 0], [rear - 1.1, radius * 1.7]], style.metal, "#202e27");
    }
    const shoulder = style.shape === "dart" ? nose - length * .48 : nose - length * .3;
    if (style.shape === "canister") {
      shape(context, [[rear, -radius * .8], [rear + .5, -radius], [nose - 1, -radius], [nose, -.7],
        [nose, .7], [nose - 1, radius], [rear + .5, radius], [rear, radius * .8]], metal, "#14221d");
    } else {
      context.beginPath(); context.moveTo(rear, -radius); context.lineTo(shoulder, -radius);
      context.quadraticCurveTo(nose - .4, -radius * .6, nose, 0);
      context.quadraticCurveTo(nose - .4, radius * .6, shoulder, radius);
      context.lineTo(rear, radius); context.closePath(); context.fillStyle = metal; context.fill();
      context.strokeStyle = "#19271f"; context.lineWidth = .35; context.stroke();
    }
    context.fillStyle = style.band; context.fillRect(rear + .6, -radius, .8, radius * 2);
    context.fillStyle = "#fff0c98c"; context.fillRect(rear + 1.6, -radius * .68, Math.max(.5, shoulder - rear - 1.8), .25);
    context.fillStyle = "#111c1e"; context.fillRect(rear - .1, -radius * .85, .35, radius * 1.7);
    if (style.shape === "heavy") {
      context.fillStyle = style.band; context.fillRect(shoulder - .9, -radius, .7, radius * 2);
      context.strokeStyle = "#2e352e"; context.lineWidth = .3;
      for (let ridge = 0; ridge < 3; ridge++) {
        context.beginPath(); context.moveTo(rear + 2.2 + ridge * 1.2, -radius * .9); context.lineTo(rear + 2.2 + ridge * 1.2, radius * .9); context.stroke();
      }
    }
    if (style.shape === "cluster" && !child) {
      for (let panel = 0; panel < 3; panel++) {
        context.strokeStyle = "#253d36"; context.lineWidth = .32;
        context.strokeRect(rear + 1.8 + panel * 1.3, -radius * .72, 1.05, radius * 1.44);
      }
    }
    if (style.shape === "drill") {
      shape(context, [[nose - 3.6, -radius], [nose + 1.2, 0], [nose - 3.6, radius]], "#c0cbd0", "#405257");
      context.strokeStyle = "#566467"; context.lineWidth = .5;
      for (let groove = 0; groove < 4; groove++) {
        const horizontal = nose - 3.3 + groove * .85, span = radius * (1 - groove * .22);
        context.beginPath(); context.moveTo(horizontal, -span); context.lineTo(horizontal + .6, span); context.stroke();
      }
    }
    if (style.shape === "dart") shape(context, [[shoulder, -radius], [nose + 1.4, 0], [shoulder, radius]], "#e4b28a", "#654a38");
    if (style.shape === "canister") {
      context.fillStyle = style.band; context.fillRect(nose - 2, -radius, .6, radius * 2);
      context.fillStyle = "#dcd9ae"; context.fillRect(-1.2, -.8, 1.7, 1.6);
      context.fillStyle = "#496153"; context.fillRect(-.65, -.7, .5, 1.4);
    }
    if (style.shape === "atomic") {
      context.fillStyle = style.band; context.beginPath(); context.arc(.5, 0, 1.35, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#303329";
      for (let sector = 0; sector < 3; sector++) {
        const rotation = sector * Math.PI * 2 / 3;
        context.beginPath(); context.moveTo(.5, 0); context.arc(.5, 0, 1.07, rotation, rotation + .9); context.closePath(); context.fill();
      }
      context.fillStyle = style.band; context.beginPath(); context.arc(.5, 0, .38, 0, Math.PI * 2); context.fill();
    }
    context.fillStyle = "#f7ead0"; context.beginPath(); context.arc(nose - .45, -.12, .28, 0, Math.PI * 2); context.fill();
  }
  context.restore();
}

export function createEffectSprites(makeCanvas) {
  const sprites = {};
  for (const [name, center, edge] of [["smoke", "#77766c", "#343b39"], ["dust", "#ccb088", "#8b725e"], ["fire", "#fff8d5", "#e36832"]]) {
    const canvas = makeCanvas(); canvas.width = 96; canvas.height = 96;
    const context = canvas.getContext("2d");
    for (let lobe = 0; lobe < 9; lobe++) {
      const rotation = lobe * 2.4, distance = lobe === 0 ? 0 : 14 + lobe % 3 * 3;
      const horizontal = 48 + Math.cos(rotation) * distance, vertical = 48 + Math.sin(rotation) * distance;
      const gradient = context.createRadialGradient(horizontal - 4, vertical - 6, 1, horizontal, vertical, 27);
      gradient.addColorStop(0, `${center}${name === "fire" ? "c8" : "78"}`);
      gradient.addColorStop(.45, `${edge}${name === "fire" ? "a0" : "60"}`); gradient.addColorStop(1, `${edge}00`);
      context.fillStyle = gradient; context.fillRect(horizontal - 28, vertical - 28, 56, 56);
    }
    sprites[name] = canvas;
  }
  return sprites;
}

export function drawFlightTrail(context, track, pose, cell, options) {
  const { now, wind, sprites, reducedMotion = false } = options;
  const style = shellStyle(pose.weaponId), points = track.leg.pts;
  const from = Math.max(0, pose.upto - (reducedMotion ? 8 : 32));
  context.save(); context.lineCap = "round";
  for (let index = from; index <= pose.upto; index++) {
    const point = points[index], next = index === pose.upto ? { x: pose.x, y: pose.y } : points[index + 1];
    const fade = (index - from + 1) / (pose.upto - from + 1);
    context.globalAlpha = fade * .26; context.strokeStyle = style.heat; context.lineWidth = .4 + fade * .45;
    context.beginPath(); context.moveTo(point.x / cell, point.y / cell); context.lineTo(next.x / cell, next.y / cell); context.stroke();
    if (!reducedMotion && index % 3 === 0) {
      const age = (pose.upto + pose.blend - index) / 48, radius = 1.3 + age * 5;
      context.globalAlpha = (1 - fade) * .16;
      context.drawImage(sprites.smoke, point.x / cell + wind * age * 1.8 - radius, point.y / cell - age * 3 - radius, radius * 2, radius * 2);
    }
  }
  if (!reducedMotion && (pose.kind === "burrow" || pose.kind === "roll")) {
    for (let fleck = 0; fleck < 7; fleck++) {
      const phase = (now * .002 + fleck / 7) % 1, side = fleck % 2 ? 1 : -1;
      context.globalAlpha = (1 - phase) * .75;
      context.fillStyle = pose.kind === "burrow" ? "#bca17a" : "#f6cf81";
      context.fillRect(pose.horizontal + side * phase * 8, pose.vertical - Math.sin(phase * Math.PI) * 5, .9, .7);
    }
  }
  context.restore();
}

export function drawMuzzleFlash(context, muzzle, now, reducedMotion) {
  const age = (now - muzzle.at) / 1000;
  if (reducedMotion || age < 0 || age > .24) return;
  const fade = Math.max(0, 1 - age / .24), style = shellStyle(muzzle.weaponId);
  const length = (style.length + 5) * (.8 + Math.sin(age * 28) * .3);
  context.save(); context.translate(muzzle.x, muzzle.y); context.rotate(Math.atan2(muzzle.dy, muzzle.dx));
  context.globalCompositeOperation = "screen";
  halo(context, 2, 0, 19 * fade + 3, "#ffb362", fade * .8);
  context.globalAlpha = fade;
  shape(context, [[-1, -2], [length * .4, -3.4], [length * .3, -1.3], [length, -.3],
    [length * .7, .8], [length * .4, 1.3], [length * .55, 3], [-1, 1.8]], "#ef9f4a");
  shape(context, [[0, -1.1], [length * .68, 0], [0, 1.1]], "#fff9dd");
  context.restore();
}

export function drawImpact(context, effect, now, options) {
  const { wind = 0, reducedMotion = false, sprites, nuclearSprites } = options;
  const age = (now - effect.at) / 1000;
  if (age < 0) return;
  const style = shellStyle(effect.weaponId), size = effect.size;
  context.save(); context.translate(effect.x, effect.y);
  if (effect.shield) {
    context.globalAlpha = Math.max(0, 1 - age / .65); context.strokeStyle = "#b5ecea"; context.lineWidth = 1.2;
    context.beginPath(); context.arc(0, 0, reducedMotion ? size : size * (.6 + age), 0, Math.PI * 2); context.stroke();
    context.restore(); return;
  }
  if (reducedMotion) {
    if (effect.nuclear) {
      context.restore(); drawNuclearCloud(context, effect, now, true); return;
    }
    context.globalAlpha = Math.max(0, 1 - age / .55) * .55;
    context.strokeStyle = effect.deposit ? "#c9b287" : style.band; context.lineWidth = 1.1;
    context.beginPath(); context.arc(0, 0, size * .7, 0, Math.PI * 2); context.stroke();
    context.restore(); return;
  }
  const nuclear = effect.nuclear, shaped = effect.weaponId === 5;
  const burstDuration = nuclear ? 1.3 : .76;
  const burst = Math.max(0, 1 - age / burstDuration);
  if (!effect.deposit && burst > 0) {
    context.globalCompositeOperation = "screen";
    halo(context, 0, -size * .08, size * (nuclear ? 2.5 : 1.65), style.heat, burst * .9);
    for (let lobe = 0; lobe < 9; lobe++) {
      const hashed = artHash(effect.weaponId, lobe, 0, 0xF1AE), rotation = lobe * 2.4;
      const reach = size * (.08 + age * 1.12), radius = size * (.18 + (hashed & 15) / 80) * (1 + age);
      const horizontal = Math.cos(rotation) * reach * (shaped ? .35 : 1), vertical = Math.sin(rotation) * reach - age * size * .28;
      context.globalAlpha = burst * .92;
      context.drawImage(sprites.fire, horizontal - radius, vertical - radius, radius * 2, radius * 2);
    }
    context.globalAlpha = 1;
    halo(context, 0, 0, Math.max(2, size * .45 * burst), "#fff9da", burst);
    if (shaped || effect.weaponId === 3) {
      context.globalAlpha = burst * .9;
      shape(context, [[-2, 0], [-.7, -size * (shaped ? 3.5 : 2) * (1 - burst + .2)], [2, 0], [0, 5]], "#fff2c4");
    }
    context.globalCompositeOperation = "source-over";
  }
  const ringDuration = nuclear ? 1.35 : .8;
  if (age < ringDuration) {
    const progress = age / ringDuration, radius = size * (.2 + Math.sqrt(progress) * (nuclear ? 2.25 : 1.5));
    context.globalAlpha = (1 - progress) ** 2 * .65;
    context.strokeStyle = effect.deposit ? "#c8b185" : style.heat; context.lineWidth = 1.1 + (1 - progress) * 1.9;
    context.beginPath(); context.ellipse(0, 2, radius, radius * .24, 0, 0, Math.PI * 2); context.stroke();
    if (!effect.deposit) {
      context.globalAlpha *= .45; context.lineWidth = .65;
      context.beginPath(); context.arc(0, 0, radius * .82, Math.PI * 1.04, Math.PI * 1.96); context.stroke();
    }
    for (let ray = 0; ray < 12; ray++) {
      const rotation = Math.PI + (ray + .5) / 12 * Math.PI, hashed = artHash(effect.weaponId, ray, 0, 0xD3B2);
      const reach = radius * (.5 + (hashed & 31) / 42);
      context.globalAlpha = (1 - progress) ** 2 * .65; context.strokeStyle = effect.deposit ? "#a38c67" : "#e9c694";
      context.lineWidth = .65 + (hashed & 3) * .25;
      context.beginPath(); context.moveTo(Math.cos(rotation) * reach * .35, Math.sin(rotation) * reach * .35);
      context.lineTo(Math.cos(rotation) * reach, Math.sin(rotation) * reach); context.stroke();
    }
  }
  const smokeDuration = 2.2;
  if (!nuclear && age > .08 && age < smokeDuration) {
    const progress = age / smokeDuration;
    const opacity = Math.sin(progress * Math.PI) * (effect.deposit ? .55 : .5) * Math.min(1, age / .35);
    for (let plume = 0; plume < 7; plume++) {
      const hashed = artHash(effect.weaponId, plume, 1, 0x510C), side = (hashed & 255) / 127.5 - 1;
      const radius = size * (.18 + progress * .4 + (hashed & 7) * .015);
      const horizontal = side * size * (.2 + progress * .55) + wind * age * 1.5;
      const vertical = -size * progress * (effect.deposit ? 1.15 : .65) * (1 - Math.abs(side) * .45);
      context.globalAlpha = opacity;
      context.drawImage(effect.deposit ? sprites.dust : sprites.smoke, horizontal - radius, vertical - radius, radius * 2, radius * 2);
    }
  }
  if (!effect.deposit && age < .6) {
    context.globalAlpha = 1; context.globalCompositeOperation = "screen";
    halo(context, 0, 0, size * .28, "#fff2c4", (1 - age / .6) * .85);
  }
  context.restore();
  if (nuclear) drawNuclearCloud(context, effect, now, false, nuclearSprites);
}

export function drawCombatParticle(context, particle, sprites, reducedMotion = false) {
  if (reducedMotion) return;
  const fade = Math.max(0, Math.min(1, particle.life / Math.min(particle.max, .5)));
  context.save(); context.globalAlpha = fade; context.fillStyle = particle.color;
  if (particle.kind === "spark") {
    context.globalCompositeOperation = "screen"; context.strokeStyle = particle.color;
    context.lineWidth = Math.max(.45, particle.size * .65); context.lineCap = "round";
    context.beginPath(); context.moveTo(particle.x, particle.y); context.lineTo(particle.x - particle.vx * .035, particle.y - particle.vy * .035); context.stroke();
    context.fillStyle = "#fff2d1"; context.fillRect(particle.x - .35, particle.y - .35, .7, .7);
  } else if (particle.kind === "debris") {
    context.translate(particle.x, particle.y); context.rotate((particle.max - particle.life) * particle.vx * .12);
    const size = particle.size;
    shape(context, [[-size, -.4 * size], [.3 * size, -size], [size, .4 * size], [-.2 * size, .7 * size]], particle.color);
    context.strokeStyle = "#e7c39888"; context.lineWidth = .3;
    context.beginPath(); context.moveTo(-size, -.4 * size); context.lineTo(.3 * size, -size); context.stroke();
  } else {
    const radius = particle.size * 2;
    const appear = Math.min(1, Math.max(0, particle.age ?? particle.max - particle.life) / .22);
    context.globalAlpha = fade * appear * (particle.kind === "smoke" ? .42 : .32);
    context.drawImage(particle.kind === "smoke" ? sprites.smoke : sprites.dust,
      particle.x - radius, particle.y - radius, radius * 2, radius * 2);
  }
  context.restore();
}

export function sampleSurface(grid, width, height) {
  const surface = [];
  for (let column = 8; column < width - 8; column += 17) {
    let row = 0;
    while (row < height && grid[row * width + column] === 0) row++;
    if (row < height) surface.push({ horizontal: column, vertical: row });
  }
  return surface;
}

export function drawWindField(context, options) {
  const { width, height, seed, now, wind, grid, surface, sprites, reducedMotion = false } = options;
  const clock = reducedMotion ? 0 : now / 1000, strength = Math.min(1, Math.abs(wind) / 5), direction = Math.sign(wind);
  const isAir = (horizontal, vertical) => {
    const column = Math.floor(horizontal), row = Math.floor(vertical);
    return column >= 0 && column < width && row >= 0 && row < height && grid[row * width + column] === 0;
  };
  context.save(); context.lineCap = "round";
  for (let index = 0; index < surface.length; index++) {
    context.globalAlpha = 1;
    const point = surface[index], hashed = artHash(seed, index, 0, 0x6A55);
    const bend = reducedMotion ? 0 : wind * .3 + Math.sin(clock * 2.8 + index) * strength * 1.1;
    if (hashed % 3 === 0) {
      context.strokeStyle = "#b9ae827a"; context.lineWidth = .55;
      for (let blade = 0; blade < 3; blade++) {
        const tipX = point.horizontal - 2 + blade * 1.7 + bend, tipY = point.vertical - 2 - (hashed >>> (blade * 3) & 3);
        if (!isAir(tipX, tipY)) continue;
        context.beginPath(); context.moveTo(point.horizontal, point.vertical);
        context.quadraticCurveTo(point.horizontal + bend * .4, point.vertical - 2, tipX, tipY); context.stroke();
      }
    }
    if (reducedMotion || !direction || index % 2) continue;
    const phase = (clock * (.15 + strength * .14) + (hashed & 255) / 255) % 1;
    const radius = 4 + phase * 11, horizontal = point.horizontal + direction * phase * (14 + strength * 36);
    const vertical = point.vertical - 3 - phase * 9;
    if (!isAir(horizontal, vertical) || !isAir(horizontal, vertical + radius * .3)) continue;
    context.globalAlpha = Math.sin(phase * Math.PI) * (.1 + strength * .12);
    context.drawImage(sprites.dust, horizontal - radius * 1.8, vertical - radius * .45, radius * 3.6, radius * .9);
  }
  context.globalAlpha = 1;
  if (!reducedMotion && direction) {
    for (let ribbon = 0; ribbon < 18; ribbon++) {
      const hashed = artHash(seed, ribbon, 1, 0xA1A);
      const speed = 22 + strength * 46, span = 12 + strength * 30;
      const horizontal = (((hashed & 65535) / 65535 * (width + 180) + direction * clock * speed) % (width + 180) + width + 180) % (width + 180) - 90;
      const vertical = 35 + ((hashed >>> 16) & 255) / 255 * (height - 80) + Math.sin(clock * .7 + ribbon) * 5;
      if (!isAir(horizontal, vertical) || !isAir(horizontal - direction * span, vertical + 2)) continue;
      const shimmer = .5 + Math.sin(clock * 1.4 + ribbon * 2) * .5;
      context.globalAlpha = (.035 + strength * .06) * shimmer;
      context.strokeStyle = "#e8d2ad"; context.lineWidth = ribbon % 3 ? .6 : 1.1;
      context.beginPath(); context.moveTo(horizontal, vertical);
      context.bezierCurveTo(horizontal - direction * span * .35, vertical - 2, horizontal - direction * span * .65, vertical + 3, horizontal - direction * span, vertical + 2); context.stroke();
    }
  }
  context.restore();
}
