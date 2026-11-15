export type Kind = 'tab' | 'group' | 'closed' | 'bookmark' | 'history';

/** Serializable item, as stored in the storage.session snapshot. */
export interface RawItem {
  k: Kind;
  /** tabId, groupId, sessionId, bookmark id, or url for history */
  id: number | string;
  title: string;
  url: string;
  /** windowId */
  win?: number;
  /** tab group id, group title, group color */
  gid?: number;
  gt?: string;
  gc?: string;
  /** active in its window */
  act?: 1;
  pin?: 1;
  aud?: 1;
  /** discarded / unloaded */
  disc?: 1;
  /** collapsed (groups) */
  col?: 1;
  /** last accessed, ms epoch */
  la?: number;
  /** favicon url (Firefox only; Chrome uses _favicon) */
  fav?: string;
  /** frecency, decayed to snapshot time */
  fr?: number;
  /** groups: tab count, most-recent tab id */
  n?: number;
  mru?: number;
}

/** Indexed item: raw fields plus precomputed match data. */
export interface Item extends RawItem {
  key: string;
  hay: string;
  low: string;
  m0: number;
  m1: number;
  /** offset of the url portion in hay; -1 when there is none */
  uOff: number;
  /** offset of the group portion in hay; -1 when there is none */
  gOff: number;
  /** position in the searcher's item list; final tiebreak */
  ord: number;
  /** query-independent rank: kind, frecency, recency, current-tab penalty */
  boost: number;
  /** lazily computed char classes for hay */
  cls?: Uint8Array;
}
