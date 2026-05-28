import type { Character, Scene } from "../types.js";

/**
 * Deterministic "cute cartoon" scene renderer used by the offline LOCAL image
 * provider. It is intentionally simple flat-vector art: rounded characters,
 * big eyes, soft palettes. In production this stage is replaced by Flux 2 /
 * Nano Banana keyframes — but this keeps the whole pipeline runnable and
 * visually demonstrable with zero API keys, and proves character consistency
 * (each character keeps the same palette across every scene).
 */

const BG: Record<Scene["setting"], [string, string]> = {
  day: ["#aee4ff", "#d7f4ff"],
  night: ["#1b2a52", "#33407a"],
  sunrise: ["#ffd6a5", "#ffb4a2"],
  indoor: ["#e8d6b3", "#cdb892"],
  water: ["#7fd4f5", "#bdeeff"],
  desert: ["#ffe2a8", "#ffd27f"],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function person(c: Character, cx: number, baseY: number, scale: number): string {
  const { skin, hair, robe } = c.palette;
  const headR = 46 * scale;
  const headY = baseY - 150 * scale;
  const bodyTop = headY + headR - 6 * scale;
  const bodyW = 120 * scale;
  const bodyH = 170 * scale;
  const eyeY = headY - 6 * scale;
  const eyeDx = 16 * scale;
  return `
    <g>
      <ellipse cx="${cx}" cy="${baseY + 6}" rx="${bodyW * 0.6}" ry="${14 * scale}" fill="rgba(0,0,0,0.12)"/>
      <path d="M ${cx - bodyW / 2} ${baseY}
               L ${cx - bodyW / 2 + 14 * scale} ${bodyTop}
               Q ${cx} ${bodyTop - 30 * scale} ${cx + bodyW / 2 - 14 * scale} ${bodyTop}
               L ${cx + bodyW / 2} ${baseY} Z"
            fill="${robe}" stroke="rgba(0,0,0,0.12)" stroke-width="${2 * scale}"/>
      <rect x="${cx - bodyW / 2 + 6 * scale}" y="${bodyTop + bodyH * 0.45}" width="${bodyW - 12 * scale}" height="${10 * scale}" rx="${5 * scale}" fill="rgba(0,0,0,0.08)"/>
      <circle cx="${cx}" cy="${headY}" r="${headR}" fill="${skin}"/>
      <path d="M ${cx - headR} ${headY - 6 * scale}
               Q ${cx} ${headY - headR - 26 * scale} ${cx + headR} ${headY - 6 * scale}
               Q ${cx} ${headY - headR + 10 * scale} ${cx - headR} ${headY - 6 * scale} Z"
            fill="${hair}"/>
      <circle cx="${cx - eyeDx}" cy="${eyeY}" r="${7 * scale}" fill="#222"/>
      <circle cx="${cx + eyeDx}" cy="${eyeY}" r="${7 * scale}" fill="#222"/>
      <circle cx="${cx - eyeDx + 2.5 * scale}" cy="${eyeY - 2.5 * scale}" r="${2.2 * scale}" fill="#fff"/>
      <circle cx="${cx + eyeDx + 2.5 * scale}" cy="${eyeY - 2.5 * scale}" r="${2.2 * scale}" fill="#fff"/>
      <circle cx="${cx - eyeDx - 4 * scale}" cy="${eyeY + 12 * scale}" r="${5 * scale}" fill="#ff9aa2" opacity="0.6"/>
      <circle cx="${cx + eyeDx + 4 * scale}" cy="${eyeY + 12 * scale}" r="${5 * scale}" fill="#ff9aa2" opacity="0.6"/>
      <path d="M ${cx - 14 * scale} ${eyeY + 18 * scale} Q ${cx} ${eyeY + 30 * scale} ${cx + 14 * scale} ${eyeY + 18 * scale}"
            fill="none" stroke="#7a3b2e" stroke-width="${3 * scale}" stroke-linecap="round"/>
    </g>`;
}

function decor(setting: Scene["setting"], w: number, h: number, seed: number): string {
  const out: string[] = [];
  const ground = h * 0.78;
  if (setting === "night") {
    for (let i = 0; i < 40; i++) {
      const x = (hash(`s${seed}${i}`) % w);
      const y = (hash(`y${seed}${i}`) % Math.floor(ground));
      const r = 1 + (hash(`r${seed}${i}`) % 2);
      out.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="0.85"/>`);
    }
    out.push(`<circle cx="${w * 0.82}" cy="${h * 0.2}" r="${h * 0.08}" fill="#fdf6c9"/>`);
  } else {
    const sx = setting === "sunrise" ? w * 0.5 : w * 0.82;
    const sy = setting === "sunrise" ? ground - 4 : h * 0.18;
    out.push(`<circle cx="${sx}" cy="${sy}" r="${h * 0.08}" fill="#ffe66d"/>`);
    for (let i = 0; i < 3; i++) {
      const cxm = (w * (0.2 + i * 0.3)) + (hash(`c${seed}${i}`) % 60);
      const cym = h * (0.12 + ((hash(`d${seed}${i}`) % 10) / 100));
      out.push(`<g fill="#ffffff" opacity="0.9"><ellipse cx="${cxm}" cy="${cym}" rx="60" ry="26"/><ellipse cx="${cxm + 45}" cy="${cym + 8}" rx="44" ry="22"/><ellipse cx="${cxm - 45}" cy="${cym + 8}" rx="44" ry="22"/></g>`);
    }
  }
  if (setting === "water") {
    out.push(`<rect x="0" y="${ground}" width="${w}" height="${h - ground}" fill="#3aa0d6"/>`);
    for (let i = 0; i < 6; i++) {
      const y = ground + 14 + i * 22;
      out.push(`<path d="M0 ${y} Q ${w / 4} ${y - 10} ${w / 2} ${y} T ${w} ${y}" stroke="#bdeeff" stroke-width="4" fill="none" opacity="0.6"/>`);
    }
  } else if (setting === "desert") {
    out.push(`<path d="M0 ${ground} Q ${w * 0.3} ${ground - 50} ${w * 0.6} ${ground} T ${w} ${ground} V ${h} H 0 Z" fill="#e9b96e"/>`);
  } else if (setting === "indoor") {
    out.push(`<rect x="0" y="${ground}" width="${w}" height="${h - ground}" fill="#a9794f"/>`);
    out.push(`<rect x="${w * 0.1}" y="${ground - 140}" width="120" height="120" rx="10" fill="#cfe8ff" stroke="#7a5a36" stroke-width="8"/>`);
  } else {
    out.push(`<path d="M0 ${ground} Q ${w * 0.5} ${ground - 70} ${w} ${ground} V ${h} H 0 Z" fill="#8ed081"/>`);
    out.push(`<path d="M0 ${ground + 30} Q ${w * 0.5} ${ground - 20} ${w} ${ground + 30} V ${h} H 0 Z" fill="#6fbf73"/>`);
  }
  return out.join("\n");
}

export function renderSceneSvg(
  scene: Scene,
  characters: Character[],
  title: string,
  w: number,
  h: number,
): string {
  const [c1, c2] = BG[scene.setting];
  const seed = hash(scene.visual + scene.narration);
  const present = characters.filter((c) => scene.characters.includes(c.name));
  const cast = present.length ? present : characters.slice(0, 2);
  const ground = h * 0.78;
  const slots = cast.slice(0, 3);
  const figures = slots
    .map((c, i) => {
      const spread = slots.length === 1 ? 0.5 : 0.28 + i * (0.44 / Math.max(1, slots.length - 1));
      return person(c, w * spread, ground + 30, 1.25);
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#sky)"/>
  ${decor(scene.setting, w, h, seed)}
  ${figures}
  <text x="${w / 2}" y="${h * 0.10}" font-family="DejaVu Serif" font-size="${Math.round(h * 0.05)}" font-weight="bold"
        fill="#ffffff" stroke="#3a2f5b" stroke-width="2" text-anchor="middle" paint-order="stroke">${escapeXml(title)}</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}
