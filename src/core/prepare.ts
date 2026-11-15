import { normUrl } from './frecency.ts';
import { classesOf, lowerAligned, maskOf, prettyUrl, siteLabel } from './text.ts';
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
  it.nu = normUrl(r.url);
  it.cls = undefined;
  it.site = undefined;
  it.ord = 0;
  it.boost = 0;
  return it;
}

export function clsOf(it: Item): Uint8Array {
  return it.cls ?? (it.cls = classesOf(it.hay));
}

/**
 * The url column's text and its offset in the haystack (for highlights; -1
 * when it isn't part of it). Computed on first draw and kept with the item.
 * The haystack keeps the whole url, so search still matches the path.
 */
export function siteOf(it: Item): [string, number] {
  if (!it.site) {
    const site = it.uOff >= 0 ? siteLabel(it.url) : '';
    // The display url starts with the host, so the first match from uOff is the domain.
    const at = site ? it.hay.indexOf(site, it.uOff) : -1;
    const end = it.gOff >= 0 ? it.gOff : it.hay.length;
    it.site = [site, at >= 0 && at < end ? at : -1];
  }
  return it.site;
}

/** Carry match data over from `old` when the searchable text did not change. */
export function reusePrepared(old: Item | undefined, r: RawItem): Item | undefined {
  if (!old || old.title !== r.title || old.url !== r.url || old.gt !== r.gt) return undefined;
  const { key, hay, low, m0, m1, uOff, gOff, nu, cls, site } = old;
  return Object.assign(r, { key, hay, low, m0, m1, uOff, gOff, nu, cls, site, ord: 0, boost: 0 });
}
