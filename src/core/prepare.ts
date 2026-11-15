import { classesOf, lowerAligned, maskOf, prettyUrl } from './text.ts';
import type { Item, RawItem } from './types.ts';

export const SEP = '  ';

export function keyOf(r: RawItem): string {
  return r.k[0] + ':' + r.id;
}

/** Build the haystack and masks once per item change, never per keystroke. */
export function prepare(r: RawItem): Item {
  const it = r as Item;
  it.key = keyOf(r);
  let hay = r.title || '';
  let uOff = -1;
  let gOff = -1;
  const disp = r.k === 'group' ? '' : prettyUrl(r.url);
  if (disp && disp !== hay) {
    uOff = hay.length + SEP.length;
    hay += SEP + disp;
  }
  if (r.gt) {
    gOff = hay.length + SEP.length;
    hay += SEP + r.gt;
  }
  it.hay = hay;
  it.low = lowerAligned(hay);
  const [m0, m1] = maskOf(it.low);
  it.m0 = m0;
  it.m1 = m1;
  it.uOff = uOff;
  it.gOff = gOff;
  it.cls = undefined;
  it.ord = 0;
  it.boost = 0;
  return it;
}

export function clsOf(it: Item): Uint8Array {
  return it.cls ?? (it.cls = classesOf(it.hay));
}
