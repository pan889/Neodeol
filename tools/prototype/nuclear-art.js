import { artHash } from "./battlefield-art.js";

export const NUCLEAR_CLOUD_MS = 6200;
export const NUCLEAR_REDUCED_MS = 1400;
const PALETTES = {
  ash: ["#c3b7a5", "#91877c", "#5b5153"],
  shadow: ["#9e9286", "#6d6260", "#433c42"],
  flame: ["#fff0b1", "#ed9c46", "#9d4b32"],
  warm: ["#d5b48b", "#9a8068", "#655152"],
};

function noise(horizontal, vertical, seed) {
  const column = Math.floor(horizontal), row = Math.floor(vertical);
  const blendX = smooth(horizontal - column), blendY = smooth(vertical - row);
  const sample = (offsetX, offsetY) => artHash(column + offsetX, row + offsetY, seed, 0xC10D) / 0xffffffff;
  const upper = sample(0, 0) * (1 - blendX) + sample(1, 0) * blendX;
  const lower = sample(0, 1) * (1 - blendX) + sample(1, 1) * blendX;
  return upper * (1 - blendY) + lower * blendY;
}

export function createNuclearSprites(makeCanvas) {
  const textures = new Map(), resolution = 128;
  for (const colors of Object.values(PALETTES)) {
    const canvas = makeCanvas(); canvas.width = resolution; canvas.height = resolution;
    const context = canvas.getContext("2d"), image = context.createImageData(resolution, resolution);
    const palette = colors.map((color) => [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16)));
    for (let row = 0; row < resolution; row++) {
      for (let column = 0; column < resolution; column++) {
        const horizontal = column / resolution * 2 - 1, vertical = row / resolution * 2 - 1;
        const distance = Math.hypot(horizontal, vertical), offset = (row * resolution + column) * 4;
        const turbulence = noise(column / 24, row / 24, 7) * .55 + noise(column / 11, row / 11, 19) * .28
          + noise(column / 4, row / 4, 31) * .12 + noise(column / 2, row / 2, 53) * .05;
        const opacity = smooth((.97 - distance + (turbulence - .5) * .35) / .19);
        const light = Math.max(0, Math.min(1, .1 + turbulence * .86 + (1 - distance) * .14 - (horizontal + vertical) * .07));
        const blend = light < .5 ? light * 2 : (light - .5) * 2;
        const lower = palette[light < .5 ? 2 : 1], upper = palette[light < .5 ? 1 : 0];
        for (let channel = 0; channel < 3; channel++) image.data[offset + channel] = lower[channel] * (1 - blend) + upper[channel] * blend;
        image.data[offset + 3] = opacity * 255;
      }
    }
    context.putImageData(image, 0, 0); textures.set(colors.join(","), canvas);
  }
  return textures;
}

export function nuclearCloudDuration(reducedMotion = false) {
  return reducedMotion ? NUCLEAR_REDUCED_MS : NUCLEAR_CLOUD_MS;
}

export function nuclearCloudBounds(effect) {
  const spread = effect.size * 1.55 + 36;
  return { left: effect.x - spread, right: effect.x + spread,
    top: effect.y - effect.size * 2.4, bottom: effect.y + effect.size * .35 };
}

function smooth(value) {
  const progress = Math.max(0, Math.min(1, value));
  return progress * progress * (3 - 2 * progress);
}

export function nuclearCloudLayout(effect, now, reducedMotion = false) {
  const age = (now - effect.at) / 1000, duration = nuclearCloudDuration(reducedMotion) / 1000;
  if (age < 0 || age >= duration) return null;
  const rise = reducedMotion ? 1 : smooth((age - .18) / 2.4);
  const spread = reducedMotion ? 1 : smooth((age - .4) / 1.9);
  const opacity = reducedMotion ? .8 * Math.min(1, (duration - age) / .4)
    : smooth((age - .12) / .55) * (1 - smooth((age - 4.15) / 2.05));
  return { age, opacity, height: effect.size * (.32 + rise * 1.35),
    halfWidth: effect.size * (.26 + spread * .83), capHeight: effect.size * (.2 + spread * .25),
    drift: reducedMotion ? 0 : Math.max(-4, Math.min(4, effect.wind ?? 0)) * Math.min(age, 5) * .9,
    heat: reducedMotion ? 0 : 1 - smooth((age - 1.1) / 3.4) };
}

function ellipse(context, horizontal, vertical, radiusX, radiusY, fill) {
  context.fillStyle = fill;
  context.beginPath(); context.ellipse(horizontal, vertical, radiusX, radiusY, 0, 0, Math.PI * 2); context.fill();
}

function billow(context, horizontal, vertical, radiusX, radiusY, colors, staticCloud, sprites, variation) {
  if (staticCloud) {
    ellipse(context, horizontal, vertical, radiusX, radiusY, colors[1]);
    return;
  }
  context.save(); context.translate(horizontal, vertical); context.scale(1, radiusY / radiusX);
  const texture = sprites?.get(colors.join(","));
  if (texture) {
    context.rotate(variation * 2.4); context.drawImage(texture, -radiusX, -radiusX, radiusX * 2, radiusX * 2);
    context.restore(); return;
  }
  const gradient = context.createRadialGradient(-radiusX * .32, -radiusX * .42, radiusX * .04, 0, 0, radiusX);
  gradient.addColorStop(0, colors[0]); gradient.addColorStop(.34, colors[1]);
  gradient.addColorStop(.65, colors[2] + "c8"); gradient.addColorStop(1, colors[2] + "00");
  ellipse(context, 0, 0, radiusX, radiusX, gradient);
  context.restore();
}

export function drawNuclearCloud(context, effect, now, reducedMotion = false, sprites = null) {
  const cloud = nuclearCloudLayout(effect, now, reducedMotion);
  if (!cloud || cloud.opacity <= 0) return;
  const { height, halfWidth, capHeight, drift, heat, opacity } = cloud, size = effect.size;
  const { ash, shadow, flame, warm } = PALETTES;
  const puff = (horizontal, vertical, radiusX, radiusY, colors, variation = 0) =>
    billow(context, horizontal, vertical, radiusX, radiusY, colors, reducedMotion, sprites, variation);
  context.save(); context.translate(effect.x, effect.y); context.globalAlpha = opacity;
  for (let dust = 0; dust < 13; dust++) {
    const side = (dust - 6) / 6, hashed = artHash(dust, 7, 0, 0xD057);
    puff(side * size * 1.1, size * .025 - (hashed & 15) * size * .005,
      size * (.25 + (hashed & 7) * .009), size * (.09 + (hashed & 3) * .016), shadow, dust);
  }
  const stem = reducedMotion ? "#9d8167" : context.createLinearGradient(0, 0, drift, -height);
  if (!reducedMotion) {
    stem.addColorStop(0, "#e4a159"); stem.addColorStop(.42, "#b98964"); stem.addColorStop(1, "#54464a");
  }
  context.beginPath(); context.moveTo(-size * .27, 0);
  context.bezierCurveTo(size * .06, -height * .34, drift - size * .23, -height * .7, drift - halfWidth * .42, -height);
  context.lineTo(drift + halfWidth * .42, -height);
  context.bezierCurveTo(drift + size * .23, -height * .7, size * .06, -height * .34, size * .27, 0);
  context.closePath(); context.fillStyle = stem; context.globalAlpha = opacity * .24; context.fill();
  context.globalAlpha = opacity;
  for (let plume = 0; plume < 11; plume++) {
    const progress = plume / 10, hashed = artHash(plume, 7, 1, 0x510C);
    const sway = reducedMotion ? 0 : Math.sin(cloud.age * 1.1 + plume * 1.7) * size * .025;
    const radius = size * (.13 + progress * .055 + (hashed & 7) * .004);
    const horizontal = drift * progress + ((plume % 2) * 2 - 1) * radius * .45 + sway;
    puff(horizontal, -height * progress, radius * 1.2, size * .23, ash, plume);
    if (!reducedMotion && progress < .8 && heat > 0) {
      context.globalAlpha = opacity * heat * .55;
      puff(horizontal - radius * .18, -height * progress, radius * .65, size * .17, flame, plume);
      context.globalAlpha = opacity;
    }
  }
  if (!reducedMotion && heat > 0) {
    context.globalAlpha = opacity * heat * .5;
    puff(drift * .3, -height * .4, size * .12, height * .45, flame);
    context.globalAlpha = opacity;
  }
  puff(drift, -height, halfWidth * 1.12, capHeight * 1.14, shadow);
  for (let crown = 0; crown < 9; crown++) {
    const side = (crown - 4) / 4, hashed = artHash(crown, 7, 2, 0xCA90);
    const radius = halfWidth * (.3 + (hashed & 7) * .012);
    puff(drift + side * halfWidth * .76, -height - capHeight * (.08 + (1 - side * side) * .55 + (hashed & 3) * .065),
      radius, capHeight * (.64 + (hashed & 3) * .04), ash, crown);
  }
  if (!reducedMotion && heat > 0) {
    context.globalAlpha = opacity * heat * .78;
    puff(drift, -height + capHeight * .35, halfWidth * .87, capHeight * .42, flame);
    context.globalAlpha = opacity;
  }
  for (let curl = 0; curl < 10; curl++) {
    const side = (curl - 4.5) / 4.5, hashed = artHash(curl, 7, 3, 0xC071);
    const roll = reducedMotion ? 0 : Math.sin(cloud.age * 1.3 + curl * 1.9) * capHeight * .045;
    const radius = halfWidth * (.22 + (hashed & 7) * .01);
    puff(drift + side * halfWidth * .85, -height + capHeight * (.12 + (1 - side * side) * .34) + roll,
      radius, capHeight * (.44 + (hashed & 3) * .06), heat > .45 ? warm : shadow, curl);
  }
  context.restore();
}
