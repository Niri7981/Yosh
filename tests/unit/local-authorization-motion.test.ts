import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { motionScript } from '../../src/modules/authority/local-authorization-motion';

type MotionFrame = { height?: string; opacity?: number; transform?: string };
class Animation {
  cancelled = false;
  currentHeight?: number;
  private resolveFinished: () => void = () => {};
  private rejectFinished: (error: Error) => void = () => {};
  finished = new Promise<void>((resolve, reject) => {
    this.resolveFinished = resolve;
    this.rejectFinished = reject;
  });
  constructor(readonly keyframes: MotionFrame[]) {}
  cancel() { this.cancelled = true; this.rejectFinished(new Error('cancelled')); }
  finish() { this.resolveFinished(); }
}

class MotionElement {
  tagName = 'DIV';
  hidden = false;
  open = false;
  inert = false;
  offsetLeft = 0;
  offsetTop = 0;
  offsetWidth = 68;
  offsetHeight = 32;
  expandedHeight = 300;
  collapsedHeight = 48;
  style = { transform: '', width: '', height: '', overflow: '' };
  attributes = new Map<string, string>();
  children: MotionElement[] = [];
  parentElement: MotionElement | null = null;
  animations: Animation[] = [];
  focus = vi.fn();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  append(...nodes: MotionElement[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  contains(node: MotionElement | null): boolean { return node === this || this.children.some(child => child.contains(node)); }
  closest(selector: string): MotionElement | null { return selector.toUpperCase() === this.tagName ? this : this.parentElement?.closest(selector) ?? null; }
  animate(keyframes: MotionFrame[]) { const animation = new Animation(keyframes); this.animations.push(animation); return animation; }
  getBoundingClientRect() {
    const active = this.animations.findLast(animation => !animation.cancelled && animation.currentHeight !== undefined);
    return { height: active?.currentHeight ?? (this.open ? this.expandedHeight : this.collapsedHeight) };
  }
}

type Click = {
  target: MotionElement; button: number; defaultPrevented: boolean;
  preventDefault: () => void;
};

// This controls browser time and animation completion around the real shipped
// script. It verifies interruption and state semantics, not rendered smoothness.
function harness(reduced = false) {
  const nav = new MotionElement(), highlight = new MotionElement();
  const buttons = [new MotionElement(), new MotionElement(), new MotionElement()];
  buttons[0].setAttribute('aria-pressed', 'true');
  buttons[1].offsetLeft = 72; buttons[1].offsetWidth = 92;
  buttons[2].offsetLeft = 168; buttons[2].offsetWidth = 76;
  nav.append(highlight, ...buttons);
  let preferenceListener: ((event: { matches: boolean }) => void) | undefined;
  const preference = { matches: reduced, addEventListener: (_name: string, listener: (event: { matches: boolean }) => void) => { preferenceListener = listener; } };
  let clickListener: ((event: Click) => void) | undefined;
  const document = {
    activeElement: null as MotionElement | null,
    getElementById: (id: string) => id === 'page-navigation' ? nav : id === 'navigation-highlight' ? highlight : null,
    querySelectorAll: () => buttons,
    addEventListener: (_name: string, listener: (event: Click) => void) => { clickListener = listener; },
  };
  let nextFrame = 0, time = 0;
  const frames = new Map<number, (time: number) => void>();
  const fetch = vi.fn(() => { throw new Error('Motion must not make requests'); });
  const scrollTo = vi.fn();
  const context = {
    document, fetch, matchMedia: () => preference, scrollTo, scrollX: 4, scrollY: 420,
    requestAnimationFrame: (callback: (time: number) => void) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  runInNewContext(motionScript, context);
  function select(index: number, animate = true) {
    runInNewContext(`yoshMotion.selectTab(document.querySelectorAll('[data-page]')[${index}],${animate})`, context);
  }
  function tick() {
    time += 1000 / 60;
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(time);
  }
  function settle() {
    for (let count = 0; frames.size && count < 240; count++) tick();
    expect(frames.size).toBe(0);
  }
  function preferenceChange(matches: boolean) { preference.matches = matches; preferenceListener?.({ matches }); }
  function click(target: MotionElement) {
    const event: Click = { target, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    clickListener?.(event); return event;
  }
  function enter(node: MotionElement) { runInNewContext('yoshMotion.enter(node)', { ...context, yoshMotion: runInNewContext('yoshMotion', context), node }); }
  function cancelWithin(node: MotionElement) { runInNewContext('yoshMotion.cancelWithin(node)', { ...context, yoshMotion: runInNewContext('yoshMotion', context), node }); }
  function disclosure() {
    const details = new MotionElement(), summary = new MotionElement(), contents = new MotionElement();
    details.tagName = 'DETAILS'; details.open = true; details.style.overflow = 'visible';
    summary.tagName = 'SUMMARY'; details.append(summary, contents);
    summary.focus.mockImplementation(() => { document.activeElement = summary; });
    return { details, summary, contents };
  }
  return { context, highlight, frames, buttons, document, fetch, scrollTo, select, tick, settle, preferenceChange, click, enter, cancelWithin, disclosure };
}

it('retargets a moving tab highlight without jumping, then settles on the most recent tab', () => {
  const h = harness();
  h.select(1); h.tick(); h.tick();
  const during = h.highlight.style.transform;
  h.select(2);
  expect(h.highlight.style.transform).toBe(during);
  expect(h.frames.size).toBe(1);
  h.settle();
  expect(h.highlight.style.transform).toBe(`translate3d(168px,0px,0) scaleX(${76 / 68})`);
  h.select(0); h.tick(); h.select(1); h.settle();
  expect(h.highlight.style.transform).toBe(`translate3d(72px,0px,0) scaleX(${92 / 68})`);
  expect(h.fetch).not.toHaveBeenCalled();
});

it('applies reduced motion immediately without animation frames or panel animations', () => {
  const h = harness(true), panel = new MotionElement();
  h.select(2); h.enter(panel);
  expect(h.highlight.style.transform).toBe(`translate3d(168px,0px,0) scaleX(${76 / 68})`);
  expect(h.frames.size).toBe(0);
  expect(panel.animations).toHaveLength(0);
  const { summary } = h.disclosure();
  expect(h.click(summary).defaultPrevented).toBe(false);
  expect(h.fetch).not.toHaveBeenCalled();
});

it('settles the current selection and cancels panel motion when reduced motion is enabled mid-flight', () => {
  const h = harness(), panel = new MotionElement();
  h.select(2); h.tick(); h.enter(panel);
  expect(h.frames.size).toBe(1);
  expect(panel.animations).toHaveLength(1);
  h.preferenceChange(true);
  expect(h.frames.size).toBe(0);
  expect(h.highlight.style.transform).toBe(`translate3d(168px,0px,0) scaleX(${76 / 68})`);
  expect(panel.animations[0].cancelled).toBe(true);
  h.enter(panel);
  expect(panel.animations).toHaveLength(1);
});

it('cancels only animations inside a hidden panel and does not resurrect that panel on completion', async () => {
  const h = harness(), panel = new MotionElement(), child = new MotionElement(), unrelated = new MotionElement();
  panel.append(child);
  h.enter(panel); h.enter(child); h.enter(unrelated);
  panel.hidden = true; h.cancelWithin(panel);
  expect(panel.animations[0].cancelled).toBe(true);
  expect(child.animations[0].cancelled).toBe(true);
  expect(unrelated.animations[0].cancelled).toBe(false);
  panel.animations[0].finish(); child.animations[0].finish();
  await Promise.resolve();
  expect(panel.hidden).toBe(true);
  expect(h.fetch).not.toHaveBeenCalled();
});

it('reverses a closing disclosure immediately and ignores the superseded completion', async () => {
  const h = harness(), { details, summary, contents } = h.disclosure();
  h.document.activeElement = contents;
  expect(h.click(summary).defaultPrevented).toBe(true);
  const closing = details.animations[0]; closing.currentHeight = 170;
  expect(contents.inert).toBe(true);
  expect(summary.focus).toHaveBeenCalledWith({ preventScroll: true });
  h.click(summary);
  expect(closing.cancelled).toBe(true);
  expect(contents.inert).toBe(false);
  expect(details.animations[1].keyframes[0].height).toBe('170px');
  closing.finish(); await Promise.resolve();
  expect(details.open).toBe(true);
  details.animations[1].finish(); await Promise.resolve();
  expect(details.open).toBe(true);
  expect(details.style.overflow).toBe('visible');
  expect(contents.inert).toBe(false);
  expect(h.fetch).not.toHaveBeenCalled();
});

it('settles a closing disclosure on reduced motion and restores each control’s original inert state', async () => {
  const h = harness(), { details, summary, contents } = h.disclosure();
  const alreadyInert = new MotionElement(); alreadyInert.inert = true; details.append(alreadyInert);
  h.click(summary);
  expect(details.open).toBe(true);
  expect(contents.inert).toBe(true);
  h.preferenceChange(true);
  expect(details.open).toBe(false);
  expect(details.animations[0].cancelled).toBe(true);
  expect(contents.inert).toBe(false);
  expect(alreadyInert.inert).toBe(true);
  expect(details.style.overflow).toBe('visible');
  details.animations[0].finish(); await Promise.resolve();
  expect(details.open).toBe(false);
});

it('restores list scroll context directly without smooth-scrolling through unrelated records', () => {
  const h = harness();
  runInNewContext('yoshMotion.restoreScroll(yoshMotion.rememberScroll())', h.context);
  expect(h.scrollTo).toHaveBeenCalledWith({ left: 4, top: 420, behavior: 'instant' });
  expect(h.frames.size).toBe(0);
  expect(h.fetch).not.toHaveBeenCalled();
});
