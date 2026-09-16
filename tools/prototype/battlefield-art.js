export const ENTITY_SCALE = 2;
export const TANK_VISUAL_SCALE = 1.12;

export function artHash(seed, column, row, salt = 0) {
  let value = (seed ^ Math.imul(column + 1, 0x9E3779B1) ^ Math.imul(row + 7, 0x85EBCA77) ^ salt) | 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7FEB352D);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846CA68B);
  return (value ^ (value >>> 16)) >>> 0;
}

function noise(seed, horizontal, vertical, scale, salt) {
  const column = Math.floor(horizontal / scale), row = Math.floor(vertical / scale);
  const fractionX = horizontal / scale - column, fractionY = vertical / scale - row;
  const blendX = fractionX * fractionX * (3 - 2 * fractionX);
  const blendY = fractionY * fractionY * (3 - 2 * fractionY);
  const upperLeft = (artHash(seed, column, row, salt) & 1023) / 1023;
  const upperRight = (artHash(seed, column + 1, row, salt) & 1023) / 1023;
  const lowerLeft = (artHash(seed, column, row + 1, salt) & 1023) / 1023;
  const lowerRight = (artHash(seed, column + 1, row + 1, salt) & 1023) / 1023;
  return (upperLeft + (upperRight - upperLeft) * blendX) * (1 - blendY)
    + (lowerLeft + (lowerRight - lowerLeft) * blendX) * blendY;
}

export function buildGeology(seed, width, height) {
  const count = width * height;
  const grain = new Uint8Array(count);
  const textures = Array.from({ length: 6 }, () => new Int8Array(count));
  const folds = Float32Array.from({ length: width }, (_value, column) =>
    Math.sin(column * .013 + (seed & 15)) * 9 + Math.sin(column * .043) * 3);
  const columns = Math.ceil(width / 30) + 3, rows = Math.ceil(height / 23) + 3;
  const sites = Array.from({ length: columns * rows }, (_value, index) => {
    const column = index % columns - 1, row = Math.floor(index / columns) - 1;
    const value = artHash(seed, column, row, 0xCA17);
    return { horizontal: (column + .2 + (value & 255) / 425) * 30,
      vertical: (row + .2 + ((value >>> 8) & 255) / 425) * 23, shade: ((value >>> 16) & 31) - 15 };
  });
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const index = row * width + column;
      const value = artHash(seed, column, row, 0x57A7);
      const fine = (value & 31) - 15;
      grain[index] = value & 15;
      const broad = (noise(seed, column, row, 63, 0xA221) - .5) * 25;
      const strata = row + folds[column];
      const seam = ((strata % 9) + 9) % 9;
      const lamina = seam < 1 ? -15 : seam < 2 ? 9 : 0;
      const ripple = Math.sin(strata * 1.25 + noise(seed, column, row, 19, 0x981) * 5);
      const siteColumn = Math.floor(column / 30), siteRow = Math.floor(row / 23);
      let nearest = Infinity, second = Infinity, nearestShade = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          const site = sites[(siteRow + offsetY + 1) * columns + siteColumn + offsetX + 1];
          const distance = Math.hypot(column - site.horizontal, (row - site.vertical) * 1.2);
          if (distance < nearest) { second = nearest; nearest = distance; nearestShade = site.shade; }
          else if (distance < second) second = distance;
        }
      }
      const crack = second - nearest < .7 ? -32 : second - nearest < 1.5 ? 14 : 0;
      const vein = Math.abs(Math.sin(strata * .115 + column * .012)) < .035 ? 19 : 0;
      const pebble = (value & 63) < 3 ? 27 : (value & 63) === 4 ? -23 : 0;
      textures[1][index] = broad * .6 + fine * .25 + ripple * 3 + (value % 149 === 0 ? 19 : 0);
      textures[2][index] = broad + lamina * .7 + fine * .28 + vein * .4;
      textures[3][index] = broad + fine * .55 + pebble + lamina * .2;
      const fractured = noise(seed, column, row, 37, 0xBEA4) > .34;
      textures[4][index] = broad + nearestShade * .45 + (fractured ? crack * .58 : 0) + lamina * .65 + vein * .65 + fine * .2;
      textures[5][index] = broad * 1.1 + nearestShade * .2 + crack * .18 + lamina * .7 + fine * .2;
    }
  }
  return { textures, grain };
}

export function terrainRelief(grid, width, height, column, row) {
  const index = row * width + column, material = grid[index];
  if (!material) return 0;
  let light = 0;
  if (row === 0 || grid[index - width] === 0) light += 30;
  else if (grid[index - width] !== material) light += 10;
  if (row + 1 < height && grid[index + width] !== material) light -= 10;
  if (column > 0 && grid[index - 1] === 0) light -= 12;
  if (column + 1 < width && grid[index + 1] === 0) light += 18;
  for (const distance of [3, 7, 12]) {
    const weight = distance === 3 ? 9 : distance === 7 ? 5 : 3;
    if (row >= distance && grid[index - distance * width] === 0) light += weight;
    if (column + distance < width && grid[index + distance] === 0) light += weight * .5;
    if (row + distance < height && grid[index + distance * width] === 0) light -= weight;
  }
  return light;
}

function polygon(context, points, fill, stroke, lineWidth = .3) {
  context.beginPath();
  context.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index++) context.lineTo(points[index][0], points[index][1]);
  context.closePath();
  if (fill) { context.fillStyle = fill; context.fill(); }
  if (stroke) { context.strokeStyle = stroke; context.lineWidth = lineWidth; context.stroke(); }
}

export function drawBackdrop(context, width, height, seed) {
  context.save();
  const sky = context.createLinearGradient(0, 0, 0, height * .57);
  sky.addColorStop(0, "#29313b"); sky.addColorStop(.38, "#8d706b");
  sky.addColorStop(.75, "#caa581"); sky.addColorStop(1, "#ddbd95");
  context.fillStyle = sky; context.fillRect(0, 0, width, height);
  const sunX = width * (.64 + (artHash(seed, 0, 0) & 255) / 255 * .12), sunY = height * .155;
  const glow = context.createRadialGradient(sunX, sunY, 10, sunX, sunY, width * .29);
  glow.addColorStop(0, "#edc69288"); glow.addColorStop(.4, "#e6b68827"); glow.addColorStop(1, "#e6b68800");
  context.fillStyle = glow; context.fillRect(0, 0, width, height);
  context.fillStyle = "#f0d4a6";
  context.beginPath(); context.arc(sunX, sunY, height * .034, 0, Math.PI * 2); context.fill();
  const corona = context.createRadialGradient(sunX, sunY, height * .026, sunX, sunY, height * .095);
  corona.addColorStop(0, "#ffe9b266"); corona.addColorStop(.35, "#f8d5a321"); corona.addColorStop(1, "#efc39100");
  context.fillStyle = corona; context.fillRect(sunX - height * .1, sunY - height * .1, height * .2, height * .2);
  for (let cloud = 0; cloud < 14; cloud++) {
    const value = artHash(seed, cloud, 2, 0xC10D);
    const horizontal = (value & 65535) / 65535 * width, vertical = height * (.035 + ((value >>> 16) & 255) / 255 * .25);
    context.save(); context.translate(horizontal, vertical); context.scale(70 + (value & 63), 3 + ((value >>> 8) & 7));
    const vapor = context.createRadialGradient(0, -.2, 0, 0, 0, 1);
    vapor.addColorStop(0, "#514f543d"); vapor.addColorStop(.45, "#80716c21"); vapor.addColorStop(1, "#9a807100");
    context.fillStyle = vapor; context.fillRect(-1, -1, 2, 2); context.restore();
  }
  for (let band = 0; band < 22; band++) {
    const value = artHash(seed, band, 0, 0xC10D);
    const vertical = height * (.04 + (value & 255) / 255 * .29);
    const cloud = context.createLinearGradient(0, vertical, width, vertical);
    cloud.addColorStop(0, "#422f3600"); cloud.addColorStop(.35, "#654a4625"); cloud.addColorStop(1, "#422f3600");
    context.fillStyle = cloud;
    context.fillRect(((value >>> 8) & 255) / 255 * width * .45, vertical, width * .65, 1 + (value >>> 16) % 4);
  }
  const layers = [
    { baseline: .22, amplitude: 55, pitch: 104, color: "#a48b7b", light: "#d2b096", shade: "#735f602e" },
    { baseline: .30, amplitude: 82, pitch: 76, color: "#7d6e64", light: "#baa08a", shade: "#3e3e442e" },
    { baseline: .39, amplitude: 69, pitch: 52, color: "#545953", light: "#929179", shade: "#252e362e" },
  ];
  layers.forEach((layer, layerIndex) => {
    const ridge = new Float32Array(width);
    for (let column = 0; column < width; column++) {
      const heightNoise = noise(seed + layerIndex * 17, column, 0, layer.pitch, 0xC117);
      const mesa = Math.min(1, Math.max(0, (heightNoise - .23) * 1.8));
      ridge[column] = height * layer.baseline + (mesa - .55) * layer.amplitude
        + (noise(seed, column, 0, 13, layerIndex) - .5) * 9;
    }
    context.save(); context.beginPath(); context.moveTo(0, height);
    for (let column = 0; column < width; column++) context.lineTo(column, ridge[column]);
    context.lineTo(width, height); context.closePath(); context.fillStyle = layer.color; context.fill(); context.clip();
    for (let column = -20; column < width; column += 19) {
      const value = artHash(seed, column, layerIndex, 0xFAC3);
      const span = 14 + (value & 31), drift = ((value >>> 8) & 31) - 15;
      const top = ridge[Math.max(0, Math.min(width - 1, column))] - 6;
      polygon(context, [[column, top], [column + span, top - 12], [column + span * .45 + drift, top + 120], [column - 10 + drift, top + 160]],
        (value & 1) ? layer.shade : `${layer.light}15`);
      context.strokeStyle = `${layer.light}1a`; context.lineWidth = .6;
      context.beginPath(); context.moveTo(column + span, top); context.lineTo(column + span * .45 + drift, top + 120); context.stroke();
    }
    for (let band = 0; band < 20; band++) {
      context.beginPath();
      for (let column = 0; column <= width; column += 6) {
        const vertical = height * layer.baseline + band * (5 + layerIndex) + Math.sin(column * .006 + band * .15) * 9;
        if (column === 0) context.moveTo(column, vertical); else context.lineTo(column, vertical);
      }
      context.lineWidth = band % 4 === 0 ? 1.2 : .5;
      context.strokeStyle = band % 3 === 0 ? `${layer.light}50` : "#302d321c"; context.stroke();
    }
    const haze = context.createLinearGradient(0, height * layer.baseline, 0, height * (layer.baseline + .23));
    haze.addColorStop(0, "#d7b18d00"); haze.addColorStop(1, layerIndex < 2 ? "#bf9c7d4a" : "#a38d7620");
    context.fillStyle = haze; context.fillRect(0, 0, width, height);
    context.restore();
  });
  context.restore();
}

export function drawArtillery(context, options) {
  const { horizontal, vertical, tilt, angle, width, height, barrelLength, team, slot, muzzle,
    alive = true, health = 100, recoil = 0, hit = false, now = 0, wind = 0, reducedMotion = false } = options;
  const facing = Math.cos(angle) >= 0 ? 1 : -1;
  const halfWidth = width / 2;
  const pivotX = muzzle ? muzzle.x - Math.cos(angle) * barrelLength : horizontal + Math.sin(tilt) * height;
  const pivotY = muzzle ? muzzle.y + Math.sin(angle) * barrelLength : vertical - Math.cos(tilt) * height;
  context.save();
  context.fillStyle = "#080b0bb3";
  context.beginPath(); context.ellipse(horizontal + 2, vertical + .4, width * .7, 1.7, 0, 0, Math.PI * 2); context.fill();
  context.save(); context.translate(horizontal, vertical); context.rotate(tilt); context.scale(facing * TANK_VISUAL_SCALE, TANK_VISUAL_SCALE);
  const armor = context.createLinearGradient(0, -12, 0, -3);
  armor.addColorStop(0, hit ? "#f0dcc1" : alive ? "#c3b491" : "#615e50");
  armor.addColorStop(.35, alive ? "#89927a" : "#42483f"); armor.addColorStop(1, "#343e35");
  const track = context.createLinearGradient(0, -4.8, 0, 0);
  track.addColorStop(0, "#a49b7d"); track.addColorStop(.23, "#292e2a"); track.addColorStop(.8, "#111817"); track.addColorStop(1, "#797e66");
  context.fillStyle = track; context.strokeStyle = "#181e19"; context.lineWidth = .65;
  context.beginPath(); context.roundRect(-halfWidth, -4.5, width, 4.8, 1.9); context.fill(); context.stroke();
  for (let wheel = -2; wheel <= 2; wheel++) {
    const wheelX = wheel * width * .16;
    context.fillStyle = "#151c18"; context.beginPath(); context.arc(wheelX, -2, 1.45, 0, Math.PI * 2); context.fill();
    context.strokeStyle = "#9c9a78"; context.lineWidth = .4; context.stroke();
    context.fillStyle = "#737962"; context.beginPath(); context.arc(wheelX, -2, .65, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#c7ba92"; context.fillRect(wheelX - .2, -2.2, .4, .4);
  }
  context.strokeStyle = "#bab395"; context.lineWidth = .32;
  for (let tread = -halfWidth + 1; tread < halfWidth; tread += 1.3) {
    context.beginPath(); context.moveTo(tread, -.05); context.lineTo(tread + .45, -.7);
    context.moveTo(tread, -4.05); context.lineTo(tread + .45, -3.5); context.stroke();
  }
  polygon(context, [[-halfWidth + .5, -4.1], [-halfWidth + 2, -6.8], [halfWidth - 2.8, -7.1], [halfWidth, -4.6], [halfWidth - .8, -3.8]], armor, "#d0c6a088", .45);
  polygon(context, [[-halfWidth + 2, -6.8], [halfWidth - 2.8, -7.1], [halfWidth - 1.2, -5.9], [-halfWidth + 1, -5.5]], "#a7ab8a");
  for (let plate = 0; plate < 4; plate++) {
    const plateX = -halfWidth + 1.2 + plate * (width - 2.4) / 4;
    polygon(context, [[plateX, -5.6], [plateX + 3.1, -5.7], [plateX + 2.8, -3.8], [plateX, -3.8]], plate % 2 ? "#5f6b54" : "#758267", "#1f302c", .3);
    context.fillStyle = "#d1c59c"; context.fillRect(plateX + .35, -5.2, .3, .3); context.fillRect(plateX + 2.1, -4.4, .3, .3);
  }
  context.fillStyle = team; context.fillRect(-halfWidth + 1.5, -5.7, 2, 1.7);
  context.fillStyle = "#1c2a25"; context.fillRect(-halfWidth + 2.1, -5.7, .5, 1.7);
  for (let vent = 0; vent < 5; vent++) {
    context.fillStyle = "#24332b"; context.fillRect(-halfWidth + 2 + vent * .6, -6.7, .3, .8);
  }
  context.strokeStyle = "#dfcda0"; context.lineWidth = .4;
  context.beginPath(); context.moveTo(-halfWidth + 1, -7); context.lineTo(-halfWidth + 4.5, -7); context.stroke();
  polygon(context, [[-4.2, -6.7], [-4.5, -9.4], [-2.8, -11.8], [1.7, -11.6], [4, -9.3], [3.2, -6.8]], armor, "#c9c19b", .4);
  polygon(context, [[-4.5, -9.4], [-2.8, -11.8], [1.7, -11.6], [2.6, -10.4], [-2.4, -10.4]], "#cbc19b");
  polygon(context, [[1.7, -11.6], [4, -9.3], [3.2, -6.8], [2, -8.7]], "#455744");
  context.strokeStyle = "#263c31"; context.lineWidth = .35;
  context.beginPath(); context.moveTo(-2.7, -10.1); context.lineTo(-3.1, -7.5); context.lineTo(1.3, -7.5); context.stroke();
  context.fillStyle = team; context.fillRect(-2.3, -9.6, 1.1, 1.8);
  context.fillStyle = "#1f2c25"; context.fillRect(-2.8, -12.3, 3.7, .7);
  context.fillStyle = "#aeb093"; context.fillRect(-2.3, -12.6, 2.2, .35);
  context.fillStyle = "#182723"; context.fillRect(.6, -11.8, 1.3, .6);
  context.fillStyle = "#b3d3c0"; context.fillRect(.85, -11.7, .7, .28);
  context.strokeStyle = "#b5bba0"; context.lineWidth = .3;
  const antennaBend = reducedMotion ? 0 : wind * .14 + Math.sin(now * .005 + slot) * Math.min(.4, Math.abs(wind) * .09);
  context.beginPath(); context.moveTo(-3.6, -10.5); context.quadraticCurveTo(-4.4, -14, -4.8 + antennaBend, -17); context.stroke();
  context.fillStyle = "#d7c58e"; context.fillRect(-5.1 + antennaBend, -17.4, .6, .7);
  polygon(context, [[-halfWidth + .8, -7.2], [-halfWidth + 3.1, -7.2], [-halfWidth + 3.1, -6.1], [-halfWidth + .8, -6.1]], "#424e41", "#c5bc98", .25);
  context.strokeStyle = "#ded1ac"; context.lineWidth = .25;
  context.beginPath(); context.moveTo(-halfWidth + 1.5, -7.2); context.lineTo(-halfWidth + 1.5, -6.1);
  context.moveTo(-halfWidth + 2.5, -7.2); context.lineTo(-halfWidth + 2.5, -6.1); context.stroke();
  context.fillStyle = "#25362e"; context.fillRect(-1.1, -12.7, 1.5, .5);
  context.fillStyle = "#bcd9cc"; context.fillRect(-.8, -12.65, .85, .18);
  context.fillStyle = "#344438"; context.fillRect(halfWidth - 2.5, -6, 1.35, .7);
  if (alive) {
    context.fillStyle = "#f2ddb0"; context.fillRect(halfWidth - 1.65, -5.85, .7, .35);
    context.fillStyle = "#eac892"; context.fillRect(-halfWidth + .5, -4.8, .45, .5);
  }
  context.fillStyle = "#e1d3ab"; context.font = "1.65px ui-monospace, monospace"; context.textAlign = "center";
  context.fillText(String(slot + 1).padStart(2, "0"), halfWidth - 4, -4.45);
  for (let scratch = 0; scratch < 4; scratch++) {
    context.strokeStyle = scratch % 2 ? "#c6bc9266" : "#15271e99"; context.lineWidth = .2;
    context.beginPath(); context.moveTo(-2 + scratch * 1.4, -6 + scratch % 2); context.lineTo(-1.4 + scratch * 1.4, -6.3 + scratch % 2); context.stroke();
  }
  if (health < 60) {
    polygon(context, [[-.7, -10.6], [.4, -10], [-.6, -8.9], [.6, -8.2]], null, "#262c25", .65);
    context.fillStyle = "#242b23"; context.fillRect(halfWidth - 4, -5.4, 1.8, .8);
  }
  context.restore();
  context.save(); context.translate(pivotX, pivotY); context.rotate(-angle);
  const retreat = Math.max(0, Math.min(1, recoil)) * 1.4;
  const barrel = context.createLinearGradient(0, -1.3, 0, 1.3);
  barrel.addColorStop(0, "#e3d5b1"); barrel.addColorStop(.4, "#a4af99"); barrel.addColorStop(.55, "#566e5c"); barrel.addColorStop(1, "#263b31");
  context.fillStyle = "#263b30"; context.beginPath(); context.arc(0, 0, 2.6, 0, Math.PI * 2); context.fill();
  context.strokeStyle = "#bcc4a2"; context.lineWidth = .45; context.stroke();
  context.translate(-retreat, 0);
  context.fillStyle = barrel; context.strokeStyle = "#20362d"; context.lineWidth = .3;
  context.beginPath(); context.roundRect(-3, -1.1, barrelLength + 3, 2.2, .4); context.fill(); context.stroke();
  context.fillStyle = "#939f82"; context.fillRect(.6, -1.5, 1.1, 3);
  context.fillStyle = barrel; context.fillRect(barrelLength - 1.65, -1.65, 1.65, 3.3);
  context.fillStyle = "#16271e"; context.fillRect(barrelLength - 1.2, -.9, .35, .6); context.fillRect(barrelLength - 1.2, .3, .35, .6);
  context.fillStyle = "#080f0c"; context.fillRect(barrelLength - .18, -1.2, .25, 2.4);
  context.restore();
  if (!reducedMotion) {
    for (let plume = 0; plume < (health < 45 ? 5 : 3); plume++) {
      const age = ((now * .00024 + plume * .25 + slot * .17) % 1 + 1) % 1;
      context.globalAlpha = (1 - age) * (alive ? health < 45 ? .23 : .07 : .36);
      context.fillStyle = alive ? "#4a4b40" : "#292e29";
      context.beginPath(); context.ellipse(horizontal - facing * halfWidth * .8 + Math.sin(age * 4) * 2 + wind * age * 1.5,
        vertical - 7 - age * (health < 45 ? 17 : 10), 1 + age * 3, 1 + age * 4, age, 0, Math.PI * 2); context.fill();
    }
  }
  context.restore();
  return { muzzleX: pivotX + Math.cos(angle) * barrelLength, muzzleY: pivotY - Math.sin(angle) * barrelLength };
}
