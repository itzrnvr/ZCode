// 颜色模型转换：设置页取色器需要 HSV（色相/饱和度/明度）作为编辑状态，
// 而 Token 与 store 只认十六进制。这里不做归一化/校验（那是 uiColors 的职责），
// 只做纯数学转换。

export interface Rgb {
  b: number;
  g: number;
  r: number;
}

export interface Hsv {
  /** 0-360 */
  h: number;
  /** 0-1 */
  s: number;
  /** 0-1 */
  v: number;
}

const HEX_PATTERN = /^#?([\da-f]{3}|[\da-f]{6})$/i;

/** 解析 #rgb / #rrggbb（可省略 #）；非法输入返回 null。 */
export function parseHexColor(value: string): Rgb | null {
  const match = HEX_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }

  const digits = match[1] ?? "";
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((d) => d + d)
          .join("")
      : digits;

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) {
      h = 60 * (((gn - bn) / delta) % 6);
    } else if (max === gn) {
      h = 60 * ((bn - rn) / delta + 2);
    } else {
      h = 60 * ((rn - gn) / delta + 4);
    }
  }
  if (h < 0) {
    h += 360;
  }

  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const chroma = v * s;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = v - chroma;

  // 六个 60° 扇区里，(chroma, secondary, 0) 的排列固定，用显式分支避免查表。
  let red = 0;
  let green = 0;
  let blue = 0;
  switch (Math.floor(hue / 60)) {
    case 0:
      red = chroma;
      green = secondary;
      break;
    case 1:
      red = secondary;
      green = chroma;
      break;
    case 2:
      green = chroma;
      blue = secondary;
      break;
    case 3:
      green = secondary;
      blue = chroma;
      break;
    case 4:
      red = secondary;
      blue = chroma;
      break;
    default:
      red = chroma;
      blue = secondary;
  }

  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 };
}

export function hexToHsv(value: string): Hsv | null {
  const rgb = parseHexColor(value);
  return rgb ? rgbToHsv(rgb) : null;
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

/**
 * 任意 CSS 颜色 → #rrggbb（拿不到颜色空间信息时返回 null）。
 *
 * 主题 Token 的计算值可能是 `rgb()`、`oklch()` 或 color-mix 的结果，
 * 字符串解析要跟着色彩空间走；交给一次离屏绘制最稳妥。
 */
export function cssColorToHex(value: string): string | null {
  if (typeof document === "undefined" || typeof CSS === "undefined" || !CSS.supports?.("color", value)) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const data = context.getImageData(0, 0, 1, 1).data;
  // 透明色没有可编辑的实体颜色，交给调用方决定回退值。
  if ((data[3] ?? 255) === 0) {
    return null;
  }
  return rgbToHex({ r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0 });
}
