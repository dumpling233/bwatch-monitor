import type { DanmakuStyle, DanmakuTextEffect } from './displayPreferences';

type Shadow = { x: number; y: number; blur: number };
const shadows: Record<DanmakuTextEffect, readonly Shadow[]> = {
  heavy: [{ x: 1, y: 0, blur: 1 }, { x: 0, y: 1, blur: 1 }, { x: 0, y: -1, blur: 1 }, { x: -1, y: 0, blur: 1 }],
  stroke: [{ x: 0, y: 0, blur: 1 }, { x: 0, y: 0, blur: 1 }, { x: 0, y: 0, blur: 1 }],
  projection: [{ x: 1, y: 1, blur: 2 }, { x: 0, y: 0, blur: 1 }],
  none: [],
};

export const danmakuFont = (style: Pick<DanmakuStyle, 'bold' | 'fontFamily'>, px: number) =>
  `${style.bold ? 700 : 400} ${px}px "${style.fontFamily}", Arial, Helvetica, sans-serif`;

export function measureDanmakuText(context: CanvasRenderingContext2D, text: string, font: string, px: number, effect: DanmakuTextEffect, framePadding = 0) {
  context.font = font;
  const metrics = context.measureText(text);
  const left = Math.max(0, metrics.actualBoundingBoxLeft || 0);
  const right = Math.max(metrics.width, metrics.actualBoundingBoxRight || 0);
  const ascent = Math.max(px * 0.8, metrics.actualBoundingBoxAscent || 0);
  const descent = Math.max(px * 0.2, metrics.actualBoundingBoxDescent || 0);
  const padding = Math.ceil(Math.max(0, ...shadows[effect].map(shadow => Math.max(Math.abs(shadow.x), Math.abs(shadow.y)) + shadow.blur * 3))) + 1;
  const frameInset = Math.max(0, Math.min(6, Math.ceil(framePadding)));
  const laneHeight = Math.ceil(Math.max(px * 1.2, ascent + descent)) + frameInset * 2;
  const width = Math.max(1, Math.ceil(left + right) + padding * 2 + frameInset * 2);
  return { width,
    height: laneHeight + padding * 2, laneHeight, drawOffsetY: -padding,
    x: padding + left + frameInset, baseline: padding + ascent + frameInset,
    frame: frameInset ? { x: 0.5, y: padding + 0.5, width: width - 1, height: laneHeight - 1 } : undefined };
}

export function createDanmakuSprite(text: string, color: string, font: string, effect: DanmakuTextEffect,
  bounds: ReturnType<typeof measureDanmakuText>, pixelRatio: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bounds.width * pixelRatio);
  canvas.height = Math.ceil(bounds.height * pixelRatio);
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.scale(pixelRatio, pixelRatio);
  context.font = font;
  context.textBaseline = 'alphabetic';
  context.fillStyle = color;
  context.shadowColor = color.toLowerCase() === '#000000' ? '#ffffff' : '#000000';
  const shift = bounds.width + 64;
  for (const shadow of [...shadows[effect]].reverse()) {
    context.shadowOffsetX = (shift + shadow.x) * pixelRatio;
    context.shadowOffsetY = shadow.y * pixelRatio;
    context.shadowBlur = shadow.blur * pixelRatio;
    context.fillText(text, bounds.x - shift, bounds.baseline);
  }
  context.shadowColor = 'transparent';
  context.shadowOffsetX = 0; context.shadowOffsetY = 0; context.shadowBlur = 0;
  context.fillText(text, bounds.x, bounds.baseline);
  return canvas;
}
