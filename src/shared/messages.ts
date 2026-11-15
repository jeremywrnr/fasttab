import type { ActItem } from './actions.ts';

export type Msg =
  | { t: 'hello' }
  | { t: 'hotkey' }
  | { t: 'visit'; url: string }
  // Overlay frame → background. Every request carries the overlay's one-time token.
  | { t: 'ov:init'; token: string }
  | { t: 'ov:bookmarks'; token: string }
  | { t: 'ov:recent'; token: string }
  | { t: 'ov:history'; token: string; text: string }
  | { t: 'ov:shortcut'; token: string }
  | { t: 'ov:favicons'; token: string }
  | { t: 'ov:settings'; token: string }
  | { t: 'ov:act'; token: string; it: ActItem; win: number; alt: boolean };
