export type Msg =
  | { t: 'hello' }
  | { t: 'visit'; url: string }
  | { t: 'focusGroup'; gid: number; tabId: number; win: number; solo: boolean }
  | { t: 'restore'; sessionId: string };
