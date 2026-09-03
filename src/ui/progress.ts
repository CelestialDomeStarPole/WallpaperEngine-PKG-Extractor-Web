export interface ProgressController {
  start(text: string, total?: number): void;
  set(done: number, text?: string): void;
  finish(text?: string): void;
  hide(): void;
}

export function createProgress(el: HTMLElement, bar: HTMLElement, textEl: HTMLElement): ProgressController {
  let total = 0;
  let hideTimer: number | undefined;

  const paint = (done: number) => {
    if (total > 0) {
      el.classList.remove('indeterminate');
      const pct = Math.min(100, Math.round((done / total) * 100));
      bar.style.width = `${pct}%`;
      textEl.textContent = `${pct}% · ${done}/${total}`;
    } else {
      textEl.textContent = `${done}`;
    }
  };

  return {
    start(text, count = 0) {
      window.clearTimeout(hideTimer);
      total = count;
      el.hidden = false;
      el.classList.toggle('indeterminate', count === 0);
      bar.style.width = count === 0 ? '' : '0%';
      textEl.textContent = text;
    },
    set(done, text) {
      if (text) textEl.textContent = text;
      else paint(done);
    },
    finish(text) {
      total = total || 1;
      el.classList.remove('indeterminate');
      bar.style.width = '100%';
      textEl.textContent = text ?? '完成';
      hideTimer = window.setTimeout(() => { el.hidden = true; }, 1200);
    },
    hide() {
      window.clearTimeout(hideTimer);
      el.hidden = true;
      el.classList.remove('indeterminate');
      bar.style.width = '0%';
    },
  };
}
