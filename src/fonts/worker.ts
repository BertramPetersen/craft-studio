import * as opentype from 'opentype.js';
import type { FontRecord } from '../core/types';
import type { FontRequest, FontResponse, ShapeResult } from './client';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const fonts = new Map<string, { font: opentype.Font; name: string; bytes: number }>();
const MAX_FONT_BYTES = 16 * 1024 * 1024;
const MAX_OUTLINE_COMMANDS = 200_000;

function fontName(font: opentype.Font): string {
  const preferred = (names?: { [language: string]: string }) =>
    names?.en?.trim() || (names && Object.values(names).find((value) => value.trim()));
  const name = preferred(font.names.fullName) ?? preferred(font.names.fontFamily);
  return (name ?? 'Unnamed font').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || 'Unnamed font';
}

async function register(bytes: ArrayBuffer, expectedId?: string): Promise<{ id: string; name: string; evicted: string[] }> {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 12 || bytes.byteLength > MAX_FONT_BYTES) {
    throw new Error('Choose a valid TTF or OTF font of at most 16 MB.');
  }
  const signature = new DataView(bytes).getUint32(0, false);
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(signature)) {
    throw new Error('Only standalone TTF and OTF fonts are supported, not WOFF, font collections, or other files.');
  }
  if (!scope.crypto?.subtle) throw new Error('Font import requires a secure context (HTTPS or localhost).');
  const digest = await scope.crypto.subtle.digest('SHA-256', bytes);
  const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (expectedId !== undefined && expectedId !== id) {
    throw new Error('Saved font content does not match its ID. Re-import the font.');
  }
  const existing = fonts.get(id);
  if (existing) { fonts.delete(id); fonts.set(id, existing); return { id, name: existing.name, evicted: [] }; }
  let font: opentype.Font;
  try {
    font = opentype.parse(bytes);
    if (!Number.isFinite(font.unitsPerEm) || font.unitsPerEm <= 0 || !font.glyphs?.length
      || !Number.isFinite(font.ascender) || !Number.isFinite(font.descender) || font.ascender <= font.descender) {
      throw new Error('No usable font metrics or glyphs.');
    }
    // Force lazy outline decoding before accepting an import as usable.
    font.glyphs.get(0).getPath(0, 0, 10);
  } catch {
    throw new Error('This font could not be parsed. Use an outline-based TTF or OTF font (not CFF2 or bitmap-only).');
  }
  const name = fontName(font);
  fonts.set(id, { font, name, bytes: bytes.byteLength });
  const evicted: string[] = [];
  let totalBytes = [...fonts.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (fonts.size > 16 || totalBytes > 64 * 1024 * 1024) {
    const oldest = fonts.keys().next().value!;
    totalBytes -= fonts.get(oldest)!.bytes; fonts.delete(oldest); evicted.push(oldest);
  }
  return { id, name, evicted };
}

function validateText(text: string, size: number): void {
  if (typeof text !== 'string' || text.length > 1000 || [...text].length > 500) {
    throw new Error('Text must contain at most 500 characters.');
  }
  if (!Number.isFinite(size) || size < 1 || size > 200) {
    throw new Error('Font size must be between 1 and 200 mm.');
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)) {
    throw new Error('Use single-line text without tabs or control characters.');
  }
  // opentype.js is not a HarfBuzz/bidi engine. Reject shaping-dependent text
  // rather than turning an incorrect visual order or unpositioned marks into a cut.
  if (/\p{Mark}|\p{Default_Ignorable_Code_Point}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\ud800-\udfff\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u200c-\u200f\u202a-\u202e\u2066-\u2069\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u.test(text)) {
    throw new Error('RTL, combining marks, and directional/emoji joining sequences require shaping this app does not support. Use precomposed simple-script characters.');
  }
  if (/[\u0900-\u109f\u1100-\u11ff\u1780-\u18af\u1900-\u1cff\ua800-\ua8ff\ua960-\ua97f\ua980-\ua9ff\uaa00-\uaaff\uabc0-\uabff\ud7b0-\ud7ff\u{11000}-\u{11fff}]/u.test(text)) {
    throw new Error('This script requires contextual shaping that is not supported. Simple Latin, Greek, Cyrillic, and individual CJK glyphs are supported when present in the font.');
  }
}

function shape(fontId: string, text: string, size: number): ShapeResult {
  validateText(text, size);
  const entry = fonts.get(fontId);
  if (!entry) throw new Error('Font is not loaded. Import or reload it before shaping text.');
  fonts.delete(fontId); fonts.set(fontId, entry);
  const font = entry.font;
  if (!text) return { path: '', bounds: { x: 0, y: 0, width: 0, height: 0 } };
  if (/^\s+$/u.test(text)) {
    const scale = size / font.unitsPerEm;
    const width = font.getAdvanceWidth(text.replace(/\s/gu, ' '), size);
    if (!Number.isFinite(width) || width < 0) throw new Error('The font produced invalid whitespace metrics.');
    return {
      path: '',
      bounds: { x: 0, y: -font.ascender * scale, width, height: (font.ascender - font.descender) * scale },
    };
  }
  let commands = 0;
  for (const character of text) {
    const index = font.charToGlyphIndex(character);
    if (!index || index >= font.glyphs.length) {
      throw new Error(`This font has no glyph for ${JSON.stringify(character)}. Choose another font or remove the character.`);
    }
    const glyph = font.glyphs.get(index);
    if (!glyph.path.commands.length && !/\s/u.test(character)) {
      throw new Error(`This font has no cuttable outline for ${JSON.stringify(character)}.`);
    }
    commands += glyph.path.commands.length;
    if (commands > MAX_OUTLINE_COMMANDS) throw new Error('This font/text combination has too many outline segments. Use shorter text or a simpler font.');
  }
  const outline = font.getPath(text, 0, 0, size, { kerning: true, features: { liga: true, rlig: true } });
  if (!outline.commands.length) throw new Error('This text has no cuttable outlines in the selected font.');
  if (outline.commands.length > MAX_OUTLINE_COMMANDS
    || outline.commands.some((command) => Object.values(command).some((value) => typeof value === 'number' && !Number.isFinite(value)))) {
    throw new Error('The font produced invalid or excessively complex outline geometry.');
  }
  const box = outline.getBoundingBox();
  const bounds = { x: box.x1, y: box.y1, width: box.x2 - box.x1, height: box.y2 - box.y1 };
  if (Object.values(bounds).some((value) => !Number.isFinite(value)) || bounds.width < 0 || bounds.height < 0) {
    throw new Error('The font produced invalid outline geometry.');
  }
  // Font size and resulting coordinates are millimetres, not CSS pixels.
  const path = outline.toPathData(5);
  if (/NaN|Infinity/.test(path)) throw new Error('The font produced invalid outline coordinates.');
  return { path, bounds };
}

scope.onmessage = (event: MessageEvent<FontRequest>) => {
  const request = event.data;
  if (!request || !Number.isSafeInteger(request.id)) return;
  void (async () => {
    try {
      let value: (FontResponse & { ok: true })['value'];
      switch (request.type) {
        case 'add': value = await register(request.bytes); break;
        case 'load': {
          const record: FontRecord = request.record;
          if (!record || typeof record.id !== 'string') throw new Error('Saved font record is invalid.');
          value = await register(record.bytes, record.id);
          break;
        }
        case 'shape': value = shape(request.fontId, request.text, request.size); break;
        default: throw new Error('Unknown font worker request.');
      }
      scope.postMessage({ id: request.id, ok: true, value } satisfies FontResponse);
    } catch (error) {
      scope.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies FontResponse);
    }
  })();
};
