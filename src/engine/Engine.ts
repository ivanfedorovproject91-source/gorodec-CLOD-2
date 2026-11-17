import { Application, Graphics } from 'pixi.js';
import { Camera } from './Camera';
import type { CameraState } from './Camera';
import { Scene, VIEW_PAD } from './Scene';
import { drawBuilding } from './BuildingRenderer';
import { applyBuildingPatch, fitHeight } from './buildingModel';
import { MIN_BUILDING_W, PRESETS, heightOf } from '../types/building';
import type { BuildingParams, PresetId } from '../types/building';
import type { GridSettings, SceneObject } from '../types/project';
import { DEFAULT_CAMERA } from '../types/project';

export type Tool = 'select' | 'draw' | 'hand';

export type DrawKind = 'block' | PresetId;

export interface EditorState {
  tool: Tool;
  drawKind: DrawKind;
  count: number;
  selected: SceneObject | null;
  canUndo: boolean;
  canRedo: boolean;
}

export interface ObjectPatch {
  x?: number; y?: number; w?: number; h?: number; name?: string;
  building?: Partial<BuildingParams>;
}

const COL = {
  sky: 0xd9dcdf,
  ground: 0x8d9296,
  groundLine: 0x2a2c2f,
  grid: 0x1c1e21,
  accent: 0x4da3ff,
  block: 0x6f757a,
  blockLine: 0x2a2c2f,
};

const MIN_SIZE = 10; // 1 м
const DEFAULT_BLOCK = 100; // 10 м
const DUPLICATE_OFFSET = 50; // 5 м

type P = { x: number; y: number };
type Handle = { hx: -1 | 0 | 1; hy: -1 | 0 | 1 };
type Drag =
  | { kind: 'pan' }
  | { kind: 'move'; id: string; start: P; startScreen: P; orig: P; before: string; moved: boolean }
  | { kind: 'resize'; id: string; h: Handle; start: P; startScreen: P; orig: { x: number; y: number; w: number; h: number }; before: string; moved: boolean }
  | { kind: 'draw'; start: P; startScreen: P; cur: P; curScreen: P };

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Рендер и ввод на PixiJS. Ничего не знает о React и Telegram. */
export class Engine {
  onCameraChange?: () => void;
  onCursorChange?: () => void;
  /** Изменился интерфейсно значимый статус: выделение, инструмент, история, объекты */
  onEditorChange?: () => void;
  /** Изменились сами объекты (для сохранения) */
  onObjectsChange?: () => void;

  private app: Application | null = null;
  private cam = new Camera();
  private scene = new Scene();
  private bg = new Graphics();
  private gridG = new Graphics();
  private gridMajor = new Graphics();
  private objectsG = new Graphics();
  private overlay = new Graphics();
  private grid: GridSettings = { visible: true, size: 10, snap: true };
  private tool: Tool = 'select';
  private drawKind: DrawKind = 'residential';
  private dirty = true;
  private camChanged = false;
  private editorChanged = true;
  private objectsChanged = false;
  private destroyed = false;
  private spaceDown = false;
  private coarse = false;
  private pointers = new Map<number, P>();
  private drag: Drag | null = null;
  private dragPointer: number | null = null;
  private cursorScreen: P | null = null;
  private canvas: HTMLCanvasElement | null = null;

  async start(host: HTMLElement, camera: CameraState, grid: GridSettings): Promise<void> {
    this.grid = { ...grid };
    this.cam.set(camera);
    this.coarse = window.matchMedia('(pointer: coarse)').matches;
    const app = new Application();
    await app.init({
      resizeTo: host,
      background: COL.sky,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    if (this.destroyed) {
      app.destroy(true, { children: true });
      return;
    }
    this.app = app;
    this.canvas = app.canvas as HTMLCanvasElement;
    host.appendChild(this.canvas);
    app.stage.addChild(this.bg, this.gridG, this.gridMajor, this.objectsG, this.overlay);
    this.attachInput(this.canvas);
    this.updateCursorStyle(null);
    app.ticker.add(() => this.tick());
  }

  destroy(): void {
    this.destroyed = true;
    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
  }

  // ---------- камера и сетка ----------
  getCamera(): CameraState { return this.cam.get(); }
  setCamera(s: CameraState): void { this.cam.set(s); this.markCamera(); }
  resetView(): void { this.setCamera({ ...DEFAULT_CAMERA }); }
  zoomBy(factor: number): void {
    this.cam.zoomAt(this.cam.viewW / 2, this.cam.viewH / 2, factor);
    this.markCamera();
  }
  setGrid(g: GridSettings): void {
    this.grid = { ...g };
    this.dirty = true;
    this.onCursorChange?.();
  }
  setSpace(v: boolean): void {
    this.spaceDown = v;
    this.updateCursorStyle(this.cursorScreen);
  }
  getCursor(): P | null {
    if (!this.cursorScreen) return null;
    return this.snapPoint(this.cam.screenToWorld(this.cursorScreen.x, this.cursorScreen.y));
  }

  // ---------- редактор ----------
  getEditorState(): EditorState {
    const s = this.scene.selected();
    return {
      tool: this.tool,
      drawKind: this.drawKind,
      count: this.scene.objects.length,
      selected: s ? (JSON.parse(JSON.stringify(s)) as SceneObject) : null,
      canUndo: this.scene.canUndo,
      canRedo: this.scene.canRedo,
    };
  }

  getObjects(): SceneObject[] {
    return JSON.parse(JSON.stringify(this.scene.objects)) as SceneObject[];
  }

  setObjects(objects: SceneObject[]): void {
    this.cancelDrag();
    this.scene.reset(objects);
    this.touch(false);
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.editorChanged = true;
    this.updateCursorStyle(this.cursorScreen);
  }

  /** Выбрать, что рисовать (блок или тип здания), и включить инструмент рисования */
  setDrawKind(k: DrawKind): void {
    this.drawKind = k;
    this.tool = 'draw';
    this.editorChanged = true;
    this.updateCursorStyle(this.cursorScreen);
  }

  selectNone(): void {
    if (!this.scene.selectedId) return;
    this.scene.selectedId = null;
    this.touch(false);
  }

  undo(): void {
    this.cancelDrag();
    if (this.scene.undo()) this.touch(true);
  }

  redo(): void {
    this.cancelDrag();
    if (this.scene.redo()) this.touch(true);
  }

  deleteSelected(): void {
    const id = this.scene.selectedId;
    if (!id) return;
    const before = this.scene.snapshot();
    this.scene.objects = this.scene.objects.filter((o) => o.id !== id);
    this.scene.selectedId = null;
    this.scene.record(before);
    this.touch(true);
  }

  duplicateSelected(): void {
    const s = this.scene.selected();
    if (!s) return;
    const before = this.scene.snapshot();
    const copy: SceneObject = JSON.parse(JSON.stringify(s));
    copy.id = this.scene.newId();
    copy.x = s.x + DUPLICATE_OFFSET;
    this.scene.objects.push(copy);
    this.scene.selectedId = copy.id;
    this.scene.record(before);
    this.touch(true);
  }

  nudge(dx: number, dy: number): void {
    const s = this.scene.selected();
    if (!s) return;
    this.updateSelected({ x: s.x + dx, y: s.y + dy });
  }

  /** Изменение выбранного объекта (инспектор, стрелки). Один шаг истории. */
  updateSelected(patch: ObjectPatch): void {
    const s = this.scene.selected();
    if (!s) return;
    const before = this.scene.snapshot();
    if (patch.x !== undefined && Number.isFinite(patch.x)) s.x = r1(patch.x);
    if (patch.y !== undefined && Number.isFinite(patch.y)) s.y = r1(patch.y);
    if (patch.w !== undefined && Number.isFinite(patch.w)) {
      s.w = Math.max(s.building ? MIN_BUILDING_W : MIN_SIZE, r1(patch.w));
    }
    if (patch.h !== undefined && Number.isFinite(patch.h)) {
      s.h = Math.max(MIN_SIZE, r1(patch.h));
      if (s.building) fitHeight(s, 'bottom'); // высота здания = целое число этажей
    }
    if (patch.building && s.building) applyBuildingPatch(s, patch.building);
    if (patch.name !== undefined) s.name = patch.name.slice(0, 60) || undefined;
    this.scene.record(before);
    this.touch(true);
  }

  // ---------- внутреннее ----------
  private touch(objects: boolean): void {
    this.scene.invalidate();
    this.dirty = true;
    this.editorChanged = true;
    if (objects) this.objectsChanged = true;
  }

  private effectiveStep(): number {
    let step = this.grid.size;
    for (let i = 0; i < 10 && step * this.cam.zoom < 10; i++) step *= 5;
    return step;
  }

  private snap1(v: number): number {
    if (!this.grid.snap) return r1(v);
    const s = this.effectiveStep();
    return Math.round(v / s) * s;
  }

  private snapPoint(w: P): P {
    return { x: this.snap1(w.x), y: this.snap1(w.y) };
  }

  private markCamera(): void {
    this.dirty = true;
    this.camChanged = true;
  }

  private local(e: { clientX: number; clientY: number }): P {
    const r = this.canvas!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private handlePoints(o: SceneObject): { h: Handle; x: number; y: number }[] {
    const out: { h: Handle; x: number; y: number }[] = [];
    const l = o.x, r = o.x + o.w, b = o.y, t = o.y + o.h;
    const levels: (-1 | 0 | 1)[] = [-1, 0, 1];
    for (const hy of levels) {
      for (const hx of levels) {
        if (hx === 0 && hy === 0) continue;
        const wx = hx < 0 ? l : hx > 0 ? r : (l + r) / 2;
        const wy = hy < 0 ? b : hy > 0 ? t : (b + t) / 2;
        const s = this.cam.worldToScreen(wx, wy);
        out.push({ h: { hx, hy }, x: s.x, y: s.y });
      }
    }
    return out;
  }

  private hitHandle(o: SceneObject, p: P): Handle | null {
    const radius = this.coarse ? 18 : 10;
    let best: Handle | null = null;
    let bestD = radius;
    for (const hp of this.handlePoints(o)) {
      const d = Math.hypot(hp.x - p.x, hp.y - p.y);
      if (d <= bestD) { bestD = d; best = hp.h; }
    }
    return best;
  }

  private handleCursor(h: Handle): string {
    if (h.hx !== 0 && h.hy !== 0) return h.hx * h.hy > 0 ? 'nesw-resize' : 'nwse-resize';
    return h.hx !== 0 ? 'ew-resize' : 'ns-resize';
  }

  private updateCursorStyle(p: P | null): void {
    if (!this.canvas || this.drag) return;
    let c = 'default';
    if (this.spaceDown || this.tool === 'hand') c = 'grab';
    else if (this.tool === 'draw') c = 'crosshair';
    else if (p) {
      const sel = this.scene.selected();
      const h = sel ? this.hitHandle(sel, p) : null;
      if (h) c = this.handleCursor(h);
      else {
        const w = this.cam.screenToWorld(p.x, p.y);
        c = this.scene.hitTest(w.x, w.y, 4 / this.cam.zoom) ? 'move' : 'grab';
      }
    }
    this.canvas.style.cursor = c;
  }

  private beginDrag(e: PointerEvent, p: P): Drag {
    if (e.button === 1 || e.button === 2 || this.spaceDown || this.tool === 'hand') return { kind: 'pan' };
    const w = this.cam.screenToWorld(p.x, p.y);
    if (this.tool === 'draw') {
      const s = this.snapPoint(w);
      return { kind: 'draw', start: s, startScreen: p, cur: s, curScreen: p };
    }
    const sel = this.scene.selected();
    if (sel) {
      const h = this.hitHandle(sel, p);
      if (h) {
        return {
          kind: 'resize', id: sel.id, h, start: w, startScreen: p, moved: false,
          orig: { x: sel.x, y: sel.y, w: sel.w, h: sel.h }, before: this.scene.snapshot(),
        };
      }
    }
    const hit = this.scene.hitTest(w.x, w.y, 4 / this.cam.zoom);
    if (hit) {
      if (this.scene.selectedId !== hit.id) {
        this.scene.selectedId = hit.id;
        this.touch(false);
      }
      return {
        kind: 'move', id: hit.id, start: w, startScreen: p, moved: false,
        orig: { x: hit.x, y: hit.y }, before: this.scene.snapshot(),
      };
    }
    if (this.scene.selectedId) {
      this.scene.selectedId = null;
      this.touch(false);
    }
    return { kind: 'pan' };
  }

  private cancelDrag(): void {
    const d = this.drag;
    this.drag = null;
    this.dragPointer = null;
    if (!d) return;
    if (d.kind === 'move' || d.kind === 'resize') {
      this.scene.load(d.before);
      this.touch(false);
    }
    this.dirty = true;
  }

  private applyDrag(d: Drag, p: P, prev: P): void {
    const w = this.cam.screenToWorld(p.x, p.y);
    switch (d.kind) {
      case 'pan':
        this.cam.panByScreen(p.x - prev.x, p.y - prev.y);
        this.markCamera();
        break;
      case 'move': {
        const o = this.scene.get(d.id);
        if (!o) break;
        if (!d.moved && Math.hypot(p.x - d.startScreen.x, p.y - d.startScreen.y) < 3) break;
        d.moved = true;
        o.x = this.snap1(d.orig.x + (w.x - d.start.x));
        o.y = this.snap1(d.orig.y + (w.y - d.start.y));
        this.touch(true);
        break;
      }
      case 'resize': {
        const o = this.scene.get(d.id);
        if (!o) break;
        if (!d.moved && Math.hypot(p.x - d.startScreen.x, p.y - d.startScreen.y) < 3) break;
        d.moved = true;
        const dx = w.x - d.start.x;
        const dy = w.y - d.start.y;
        const g = d.orig;
        let left = g.x, right = g.x + g.w, bottom = g.y, top = g.y + g.h;
        if (d.h.hx < 0) left = this.snap1(g.x + dx);
        if (d.h.hx > 0) right = this.snap1(g.x + g.w + dx);
        if (d.h.hy < 0) bottom = this.snap1(g.y + dy);
        if (d.h.hy > 0) top = this.snap1(g.y + g.h + dy);
        const minW = o.building ? MIN_BUILDING_W : MIN_SIZE;
        if (right - left < minW) { if (d.h.hx < 0) left = right - minW; else right = left + minW; }
        if (top - bottom < MIN_SIZE) { if (d.h.hy < 0) bottom = top - MIN_SIZE; else top = bottom + MIN_SIZE; }
        o.x = left; o.w = right - left; o.y = bottom; o.h = top - bottom;
        if (o.building) fitHeight(o, d.h.hy < 0 ? 'top' : 'bottom'); // этажи добавляются/убираются
        this.touch(true);
        break;
      }
      case 'draw':
        d.cur = this.snapPoint(w);
        d.curScreen = p;
        this.dirty = true;
        break;
    }
  }

  private finishDraw(d: Extract<Drag, { kind: 'draw' }>): void {
    const preset = this.drawKind === 'block' ? null : PRESETS[this.drawKind];
    const click = Math.hypot(d.curScreen.x - d.startScreen.x, d.curScreen.y - d.startScreen.y) < 4;
    let x: number, y: number, w: number, h: number;
    if (click) {
      x = d.start.x; y = d.start.y;
      w = preset ? preset.defaultW : DEFAULT_BLOCK;
      h = DEFAULT_BLOCK;
    } else {
      x = Math.min(d.start.x, d.cur.x); y = Math.min(d.start.y, d.cur.y);
      w = Math.abs(d.cur.x - d.start.x); h = Math.abs(d.cur.y - d.start.y);
    }
    if (w < (preset ? MIN_BUILDING_W : MIN_SIZE)) return;
    const before = this.scene.snapshot();
    let obj: SceneObject;
    if (preset) {
      const building = { ...preset.params };
      obj = { id: this.scene.newId(), kind: 'building', x, y, w, h, building };
      if (click) obj.h = heightOf(building); // клик — типовая высота
      else fitHeight(obj, 'bottom'); // протяжка — число этажей по высоте
    } else {
      if (h < MIN_SIZE) return;
      obj = { id: this.scene.newId(), kind: 'block', x, y, w, h };
    }
    this.scene.objects.push(obj);
    this.scene.selectedId = obj.id;
    this.scene.record(before);
    this.touch(true);
  }

  private endDrag(): void {
    const d = this.drag;
    this.drag = null;
    this.dragPointer = null;
    if (!d) return;
    if (d.kind === 'move' || d.kind === 'resize') {
      if (this.scene.record(d.before)) this.touch(true);
    } else if (d.kind === 'draw') {
      this.finishDraw(d);
    }
    this.editorChanged = true;
    this.dirty = true;
  }

  private attachInput(canvas: HTMLCanvasElement): void {
    canvas.style.touchAction = 'none';
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.local(e);
        const dy = Math.max(-100, Math.min(100, e.deltaY));
        this.cam.zoomAt(p.x, p.y, Math.exp(-dy * 0.0015));
        this.markCamera();
      },
      { passive: false },
    );

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      this.cursorScreen = p;
      if (this.pointers.size > 1) {
        this.cancelDrag(); // второй палец — щипок, прерываем перетаскивание
        return;
      }
      this.drag = this.beginDrag(e, p);
      this.dragPointer = e.pointerId;
      if (this.drag.kind === 'pan') canvas.style.cursor = 'grabbing';
      this.dirty = true;
    });

    canvas.addEventListener('pointermove', (e) => {
      const p = this.local(e);
      this.cursorScreen = p;
      const prev = this.pointers.get(e.pointerId);
      if (prev) {
        if (this.pointers.size === 2) {
          const entry = Array.from(this.pointers.entries()).find(([id]) => id !== e.pointerId);
          if (entry) {
            const o = entry[1];
            const prevDist = Math.hypot(prev.x - o.x, prev.y - o.y);
            const newDist = Math.hypot(p.x - o.x, p.y - o.y);
            const prevMid = { x: (prev.x + o.x) / 2, y: (prev.y + o.y) / 2 };
            const newMid = { x: (p.x + o.x) / 2, y: (p.y + o.y) / 2 };
            this.cam.panByScreen(newMid.x - prevMid.x, newMid.y - prevMid.y);
            if (prevDist > 0 && newDist > 0) this.cam.zoomAt(newMid.x, newMid.y, newDist / prevDist);
            this.markCamera();
          }
        } else if (this.drag && this.dragPointer === e.pointerId) {
          this.applyDrag(this.drag, p, prev);
        }
        this.pointers.set(e.pointerId, p);
      } else {
        this.updateCursorStyle(p);
      }
      this.dirty = true;
      this.onCursorChange?.();
    });

    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.dragPointer === e.pointerId) this.endDrag();
      if (e.pointerType !== 'mouse') {
        this.cursorScreen = null;
        this.onCursorChange?.();
      }
      this.updateCursorStyle(e.pointerType === 'mouse' ? this.local(e) : null);
      this.dirty = true;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') {
        this.cursorScreen = null;
        this.dirty = true;
        this.onCursorChange?.();
      }
    });
  }

  private tick(): void {
    const app = this.app;
    if (!app) return;
    const w = app.screen.width;
    const h = app.screen.height;
    if (w !== this.cam.viewW || h !== this.cam.viewH) {
      this.cam.viewW = w;
      this.cam.viewH = h;
      this.markCamera();
    }
    if (this.dirty) {
      this.dirty = false;
      this.redraw(w, h);
    }
    if (this.camChanged) {
      this.camChanged = false;
      this.onCameraChange?.();
    }
    if (this.editorChanged) {
      this.editorChanged = false;
      this.onEditorChange?.();
    }
    if (this.objectsChanged) {
      this.objectsChanged = false;
      this.onObjectsChange?.();
    }
  }

  private redraw(w: number, h: number): void {
    const cam = this.cam;
    const gy = cam.worldToScreen(0, 0).y;

    // небо и земля
    this.bg.clear();
    const skyH = Math.max(0, Math.min(h, gy));
    if (skyH > 0) this.bg.rect(0, 0, w, skyH).fill(COL.sky);
    if (gy < h) {
      const top = Math.max(0, gy);
      this.bg.rect(0, top, w, h - top).fill(COL.ground);
    }
    if (gy >= 0 && gy <= h) {
      this.bg.moveTo(0, gy).lineTo(w, gy).stroke({ width: 2, color: COL.groundLine });
    }

    // сетка
    this.gridG.clear();
    this.gridMajor.clear();
    if (this.grid.visible) {
      const step = this.effectiveStep();
      const b = cam.visibleBounds();
      const i0 = Math.floor(b.minX / step);
      const i1 = Math.ceil(b.maxX / step);
      const j0 = Math.floor(b.minY / step);
      const j1 = Math.ceil(b.maxY / step);
      if (i1 - i0 < 600 && j1 - j0 < 600) {
        const minor = this.gridG;
        const major = this.gridMajor;
        let hasMinor = false;
        let hasMajor = false;
        for (let i = i0; i <= i1; i++) {
          const sx = Math.round(cam.worldToScreen(i * step, 0).x) + 0.5;
          if (i % 5 === 0) { major.moveTo(sx, 0).lineTo(sx, h); hasMajor = true; }
          else { minor.moveTo(sx, 0).lineTo(sx, h); hasMinor = true; }
        }
        for (let j = j0; j <= j1; j++) {
          const sy = Math.round(cam.worldToScreen(0, j * step).y) + 0.5;
          if (j % 5 === 0) { major.moveTo(0, sy).lineTo(w, sy); hasMajor = true; }
          else { minor.moveTo(0, sy).lineTo(w, sy); hasMinor = true; }
        }
        if (hasMinor) minor.stroke({ width: 1, color: COL.grid, alpha: 0.1 });
        if (hasMajor) major.stroke({ width: 1, color: COL.grid, alpha: 0.22 });
      }
    }

    // объекты: чанки по X из пространственного индекса + отсечение по экрану
    this.objectsG.clear();
    const vb = cam.visibleBounds();
    for (const o of this.scene.visible(vb.minX, vb.maxX)) {
      if (o.x > vb.maxX || o.x + o.w + VIEW_PAD < vb.minX || o.y > vb.maxY || o.y + o.h + VIEW_PAD < vb.minY) continue;
      if (o.building) {
        drawBuilding(this.objectsG, o, cam);
      } else {
        const tl = cam.worldToScreen(o.x, o.y + o.h);
        this.objectsG.rect(tl.x, tl.y, o.w * cam.zoom, o.h * cam.zoom).fill(COL.block);
        this.objectsG.rect(tl.x, tl.y, o.w * cam.zoom, o.h * cam.zoom).stroke({ width: 1, color: COL.blockLine });
      }
    }

    // выделение, предпросмотр рисования, маркер курсора
    this.overlay.clear();
    const sel = this.scene.selected();
    if (sel) {
      const tl = cam.worldToScreen(sel.x, sel.y + sel.h);
      this.overlay.rect(tl.x, tl.y, sel.w * cam.zoom, sel.h * cam.zoom).stroke({ width: 1.5, color: COL.accent });
      const half = this.coarse ? 6 : 4;
      for (const hp of this.handlePoints(sel)) {
        this.overlay.rect(hp.x - half, hp.y - half, half * 2, half * 2).fill(0xffffff);
        this.overlay.rect(hp.x - half, hp.y - half, half * 2, half * 2).stroke({ width: 1.5, color: COL.accent });
      }
    }
    const d = this.drag;
    if (d && d.kind === 'draw' && Math.hypot(d.curScreen.x - d.startScreen.x, d.curScreen.y - d.startScreen.y) >= 4) {
      const a = cam.worldToScreen(d.start.x, d.start.y);
      const c = cam.worldToScreen(d.cur.x, d.cur.y);
      const rx = Math.min(a.x, c.x), ry = Math.min(a.y, c.y), rw = Math.abs(c.x - a.x), rhh = Math.abs(c.y - a.y);
      this.overlay.rect(rx, ry, rw, rhh).fill({ color: COL.accent, alpha: 0.18 });
      this.overlay.rect(rx, ry, rw, rhh).stroke({ width: 1.5, color: COL.accent });
    }
    if (this.cursorScreen && !this.coarse) {
      const wp = this.snapPoint(cam.screenToWorld(this.cursorScreen.x, this.cursorScreen.y));
      const s = cam.worldToScreen(wp.x, wp.y);
      this.overlay
        .moveTo(s.x - 8, s.y).lineTo(s.x + 8, s.y)
        .moveTo(s.x, s.y - 8).lineTo(s.x, s.y + 8)
        .stroke({ width: 1, color: COL.accent });
    }
  }
}
