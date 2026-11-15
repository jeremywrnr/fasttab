// Fixed-row-height virtual list. Only visible rows (plus overscan) exist in
// the DOM; row elements are recycled and positioned with transforms.

export interface Row {
  el: HTMLDivElement;
  fav: HTMLImageElement;
  dot: HTMLSpanElement;
  t: HTMLDivElement;
  u: HTMLDivElement;
  chip: HTMLSpanElement;
  badge: HTMLSpanElement;
  /** render signature; skip work when unchanged */
  sig: string;
  idx: number;
}

const OVERSCAN = 4;

function makeRow(): Row {
  const el = document.createElement('div');
  el.className = 'row';
  const fav = document.createElement('img');
  fav.className = 'fav';
  fav.decoding = 'async';
  fav.alt = '';
  fav.onerror = () => (fav.hidden = true);
  const dot = document.createElement('span');
  dot.className = 'dot';
  const txt = document.createElement('div');
  txt.className = 'txt';
  const t = document.createElement('div');
  t.className = 't';
  const u = document.createElement('div');
  u.className = 'u';
  txt.append(t, u);
  const chip = document.createElement('span');
  chip.className = 'chip';
  const badge = document.createElement('span');
  badge.className = 'badge';
  el.append(fav, dot, txt, chip, badge);
  return { el, fav, dot, t, u, chip, badge, sig: '', idx: -1 };
}

export class VList {
  private rows: Row[] = [];
  private count = 0;
  private rowH: number;
  private scheduled = 0;
  onHover: ((i: number) => void) | null = null;

  constructor(
    private scroller: HTMLElement,
    private inner: HTMLElement,
    private render: (row: Row, i: number) => void,
    onClick: (i: number, e: MouseEvent) => void,
  ) {
    this.rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 44;
    scroller.addEventListener(
      'scroll',
      () => {
        if (!this.scheduled) this.scheduled = requestAnimationFrame(() => ((this.scheduled = 0), this.draw()));
      },
      { passive: true },
    );
    const idxOf = (e: Event) => {
      const el = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
      return el ? Number(el.dataset.i) : -1;
    };
    inner.addEventListener('click', (e) => {
      const i = idxOf(e);
      if (i >= 0) onClick(i, e);
    });
    // mousemove, not mouseover: rows sliding under a still cursor while
    // scrolling with the keyboard must not steal the selection.
    let lx = -1;
    let ly = -1;
    inner.addEventListener('mousemove', (e) => {
      if (e.clientX === lx && e.clientY === ly) return;
      lx = e.clientX;
      ly = e.clientY;
      const i = idxOf(e);
      if (i >= 0) this.onHover?.(i);
    });
  }

  get pageSize(): number {
    return Math.max(1, Math.floor(this.scroller.clientHeight / this.rowH) - 1);
  }

  setCount(n: number): void {
    if (n === this.count) return;
    this.count = n;
    this.inner.style.height = n * this.rowH + 'px';
  }

  reveal(i: number): void {
    const top = i * this.rowH;
    const st = this.scroller.scrollTop;
    const h = this.scroller.clientHeight || this.rowH * 10;
    if (top < st) this.scroller.scrollTop = top;
    else if (top + this.rowH > st + h) this.scroller.scrollTop = top + this.rowH - h;
  }

  draw(): void {
    const h = this.scroller.clientHeight || this.rowH * 10;
    const st = this.scroller.scrollTop;
    const first = Math.max(0, Math.floor(st / this.rowH) - OVERSCAN);
    const last = Math.min(this.count, Math.ceil((st + h) / this.rowH) + OVERSCAN);
    const need = last - first;
    while (this.rows.length < need) {
      const r = makeRow();
      this.rows.push(r);
      this.inner.appendChild(r.el);
    }
    // Keep each index on the same element across scrolls (i mod pool) so
    // unchanged rows skip re-rendering.
    const pool = this.rows.length;
    const used = new Set<number>();
    for (let i = first; i < last; i++) {
      const slot = i % pool;
      used.add(slot);
      const r = this.rows[slot];
      if (r.idx !== i) {
        r.idx = i;
        r.sig = '';
        r.el.dataset.i = String(i);
        r.el.style.transform = `translateY(${i * this.rowH}px)`;
      }
      r.el.hidden = false;
      this.render(r, i);
    }
    for (let k = 0; k < pool; k++) {
      if (!used.has(k)) {
        const r = this.rows[k];
        r.el.hidden = true;
        r.idx = -1;
      }
    }
  }
}
