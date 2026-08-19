import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { BrushStyle, DrawTool, Stroke, StrokeShape } from '@sketch-arena/protocol';
import { sampleStrokePoints, splitStrokeForTransport } from './strokeTransport';

export type LayerBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';
export interface CanvasLayer { id: string; name: string; strokes: Stroke[]; visible: boolean; opacity: number; locked: boolean; blendMode: LayerBlendMode; }
export interface CanvasViewport { zoom: number; rotation: number; panX: number; panY: number; }
interface Props {
  strokes: Stroke[]; active: boolean; expert?: boolean; arenaTools?: boolean; layers?: CanvasLayer[]; activeLayerId?: string;
  width?: number; height?: number; onStroke?: (stroke: Stroke) => void; onPreview?: (stroke: Stroke) => void;
  onClear?: () => void; onUndo?: () => void; activeLayerLocked?: boolean; onLayerTranslate?: (x: number, y: number) => void;
  transportPointLimit?: number;
  viewport?: CanvasViewport; onViewportChange?: (viewport: CanvasViewport) => void; panMode?: boolean;
  expertPanelCollapsed?: boolean; onToggleExpertPanel?: () => void;
}
type CanvasTool = DrawTool | 'eyedropper' | 'move' | 'line' | 'rectangle' | 'ellipse' | 'arrow' | 'triangle';
interface LayerRenderCache { canvas: HTMLCanvasElement; strokes: Stroke[]; pixelWidth: number; pixelHeight: number; ratio: number; }
interface PreviewSurface { canvas: HTMLCanvasElement; pixelWidth: number; pixelHeight: number; }
export interface CanvasHandle { pngDataUrl: () => string | null; }
const COMMON_COLORS = ['#000000', '#ffffff', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6'];
const MAX_GESTURE_POINTS = 7_000;
const BRUSHES: Array<{ id: BrushStyle; label: string; detail: string }> = [
  { id: 'pencil', label: 'Pencil', detail: 'Pressure graphite' }, { id: 'ink', label: 'Inker', detail: 'Tapered wet line' },
  { id: 'marker', label: 'Marker', detail: 'Broad ink stacking' }, { id: 'airbrush', label: 'Airbrush', detail: 'Soft particle spray' },
  { id: 'charcoal', label: 'Charcoal', detail: 'Fibres + loose dust' }, { id: 'technical', label: 'Technical', detail: 'Constant precision' },
  { id: 'watercolor', label: 'Watercolor', detail: 'Layered wet wash' }, { id: 'pastel', label: 'Pastel', detail: 'Powder + grain' },
  { id: 'pixel', label: 'Pixel', detail: 'Snapped square trail' }, { id: 'calligraphy', label: 'Calligraphy', detail: 'Angled ribbon nib' },
  { id: 'neon', label: 'Neon', detail: 'Glow + bright core' },
];
const COSMETIC_BRUSHES: Record<string, { brush: BrushStyle; color: string }> = {
  'panic-pencil': { brush: 'pencil', color: '#e54b3e' },
  'riot-marker-brush': { brush: 'marker', color: '#ef476f' },
  'neon-panic-brush': { brush: 'neon', color: '#8b5cf6' },
  'chaos-charcoal-brush': { brush: 'charcoal', color: '#34302d' },
};

export const BRUSH_RENDER_PROFILES: Record<BrushStyle, { width: number; alpha: number; texture: string }> = {
  pencil: { width: .7, alpha: .82, texture: 'graphite' }, ink: { width: .95, alpha: 1, texture: 'tapered' },
  marker: { width: 1.55, alpha: .32, texture: 'overprint' }, airbrush: { width: 2.5, alpha: .2, texture: 'spray' },
  charcoal: { width: 1.15, alpha: .7, texture: 'fibres' }, technical: { width: .42, alpha: 1, texture: 'constant' },
  watercolor: { width: 1.85, alpha: .2, texture: 'wash' }, pastel: { width: 1.35, alpha: .58, texture: 'powder' },
  pixel: { width: 1, alpha: 1, texture: 'squares' }, calligraphy: { width: 1.5, alpha: .95, texture: 'ribbon' },
  neon: { width: .86, alpha: 1, texture: 'glow-core' },
};

export function savedStrokeLayers(strokes: Stroke[]): CanvasLayer[] | undefined {
  if (!strokes.some((stroke) => stroke.layerId)) return undefined;
  return strokes.reduce<CanvasLayer[]>((items, stroke) => {
    const id = stroke.layerId ?? '__flat__'; let layer = items.find((item) => item.id === id);
    if (!layer) { layer = { id, name: id, strokes: [], visible: true, opacity: 1, locked: false, blendMode: stroke.blendMode ?? 'normal' }; items.push(layer); }
    layer.strokes.push(stroke); return items;
  }, []);
}

function loadCustomColors(): string[] {
  try { const value = JSON.parse(localStorage.getItem('sketch-arena-custom-colors') ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && /^#[0-9a-f]{6}$/i.test(item)).slice(0, 24) : []; }
  catch { return []; }
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas({ strokes, active, expert = false, arenaTools = false, layers, activeLayerId, width = 2400, height = 2400, onStroke, onPreview, onClear, onUndo, activeLayerLocked = false, onLayerTranslate, transportPointLimit, viewport = { zoom: 1, rotation: 0, panX: 0, panY: 0 }, onViewportChange, panMode = false, expertPanelCollapsed = false, onToggleExpertPanel }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null); const boardRef = useRef<HTMLDivElement>(null);
  const current = useRef<Stroke | null>(null); const lastPreview = useRef(0); const moveStart = useRef<{ x: number; y: number } | null>(null); const moveEnd = useRef<{ x: number; y: number } | null>(null);
  const spaceHeld = useRef(false); const panDrag = useRef<{ pointerId: number; clientX: number; clientY: number; viewport: CanvasViewport } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>()); const touchGesture = useRef<{ distance: number; angle: number; centerX: number; centerY: number; viewport: CanvasViewport } | null>(null);
  const layerRenderCache = useRef<Map<string, LayerRenderCache>>(new Map()); const previewSurface = useRef<PreviewSurface | null>(null);
  const equippedBrush = expert || arenaTools ? localStorage.getItem('sketch-equipped-brush') : null; const equippedPreset = equippedBrush ? COSMETIC_BRUSHES[equippedBrush] : undefined;
  const [tool, setTool] = useState<CanvasTool>('pencil'); const [brush, setBrush] = useState<BrushStyle>(() => equippedPreset?.brush ?? 'pencil');
  const [color, setColor] = useState(() => equippedPreset?.color ?? '#171514'); const [size, setSize] = useState(6);
  const [opacity, setOpacity] = useState(100); const [smoothing, setSmoothing] = useState(45);
  const [customColors, setCustomColors] = useState<string[]>(loadCustomColors);
  const [showGrid, setShowGrid] = useState(false); const [symmetry, setSymmetry] = useState<'none' | 'vertical' | 'horizontal'>('none');
  useImperativeHandle(ref, () => ({ pngDataUrl: () => canvasRef.current?.toDataURL('image/png') ?? null }), []);

  const render = useCallback(() => {
    const canvas = canvasRef.current; const board = boardRef.current; if (!canvas || !board) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(board.clientWidth * ratio)); const pixelHeight = Math.max(1, Math.floor(board.clientHeight * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; context.fillStyle = '#f4f0e8'; context.fillRect(0, 0, pixelWidth, pixelHeight);
    const savedLayers = !layers ? savedStrokeLayers(strokes) : undefined;
    const displayLayers = layers ?? savedLayers;
    if (displayLayers) {
      const retainedLayerIds = new Set(displayLayers.map((layer) => layer.id));
      for (const id of layerRenderCache.current.keys()) if (!retainedLayerIds.has(id)) layerRenderCache.current.delete(id);
      for (const layer of displayLayers) {
        if (!layer.visible) continue;
        let cached = layerRenderCache.current.get(layer.id);
        if (!cached || cached.strokes !== layer.strokes || cached.pixelWidth !== pixelWidth || cached.pixelHeight !== pixelHeight || cached.ratio !== ratio) {
          const layerCanvas = document.createElement('canvas'); layerCanvas.width = pixelWidth; layerCanvas.height = pixelHeight;
          const layerContext = layerCanvas.getContext('2d'); if (!layerContext) continue;
          for (const stroke of layer.strokes) drawStroke(layerContext, stroke, pixelWidth, pixelHeight, ratio, true);
          cached = { canvas: layerCanvas, strokes: layer.strokes, pixelWidth, pixelHeight, ratio }; layerRenderCache.current.set(layer.id, cached);
        }
        let surface = cached.canvas;
        if (layer.id === activeLayerId && current.current) {
          let preview = previewSurface.current;
          if (!preview || preview.pixelWidth !== pixelWidth || preview.pixelHeight !== pixelHeight) {
            const previewCanvas = document.createElement('canvas'); previewCanvas.width = pixelWidth; previewCanvas.height = pixelHeight;
            preview = { canvas: previewCanvas, pixelWidth, pixelHeight }; previewSurface.current = preview;
          }
          const previewContext = preview.canvas.getContext('2d');
          if (previewContext) {
            previewContext.clearRect(0, 0, pixelWidth, pixelHeight); previewContext.globalAlpha = 1; previewContext.globalCompositeOperation = 'source-over';
            previewContext.drawImage(cached.canvas, 0, 0); drawStroke(previewContext, current.current, pixelWidth, pixelHeight, ratio, true); surface = preview.canvas;
          }
        }
        context.save(); context.globalAlpha = layer.opacity; context.globalCompositeOperation = layer.blendMode === 'normal' ? 'source-over' : layer.blendMode; context.drawImage(surface, 0, 0); context.restore();
      }
    } else {
      for (const stroke of strokes) drawStroke(context, stroke, pixelWidth, pixelHeight, ratio, false);
      if (current.current) drawStroke(context, current.current, pixelWidth, pixelHeight, ratio, false);
    }
  }, [activeLayerId, layers, strokes]);

  useEffect(() => { render(); }, [render]);
  useEffect(() => { localStorage.setItem('sketch-arena-custom-colors', JSON.stringify(customColors)); }, [customColors]);
  useEffect(() => { const board = boardRef.current; if (!board) return; const observer = new ResizeObserver(() => render()); observer.observe(board); return () => observer.disconnect(); }, [render]);
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); onUndo?.(); return; }
      if (event.code === 'Space') { event.preventDefault(); spaceHeld.current = true; return; }
      const key = event.key.toLowerCase(); if (key === 'p' || key === 'b') setTool('pencil'); if (key === 'e') setTool('eraser');
      if (key === 'f') setTool('fill'); if (key === 'i') setTool('eyedropper'); if (key === 'v') setTool('move');
      if (key === 'l') setTool('line'); if (key === 'r') setTool('rectangle'); if (key === 'o') setTool('ellipse');
    };
    const release = (event: KeyboardEvent) => { if (event.code === 'Space') spaceHeld.current = false; };
    window.addEventListener('keydown', listener); window.addEventListener('keyup', release); return () => { window.removeEventListener('keydown', listener); window.removeEventListener('keyup', release); };
  }, [active, onUndo]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const board = boardRef.current; if (!board) return { x: 0, y: 0, pressure: .5 };
    return { ...screenToCanvasPoint(event.clientX, event.clientY, board, viewport), pressure: event.pressure > 0 ? event.pressure : .5 };
  };
  const pickColor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; const board = boardRef.current; if (!canvas || !board) return; const local = screenToCanvasPoint(event.clientX, event.clientY, board, viewport);
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(local.x * canvas.width)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(local.y * canvas.height)));
    const pixel = canvas.getContext('2d')?.getImageData(x, y, 1, 1).data; if (!pixel) return;
    setColor(`#${[pixel[0], pixel[1], pixel[2]].map((value) => value!.toString(16).padStart(2, '0')).join('')}`); setTool('pencil');
  };
  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active) return;
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size === 2) { current.current = null; moveStart.current = null; const pair = [...touches.current.values()]; touchGesture.current = gestureSnapshot(pair[0]!, pair[1]!, viewport); render(); event.currentTarget.setPointerCapture(event.pointerId); return; }
    }
    if (panMode || spaceHeld.current || event.button === 1) { panDrag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewport }; event.currentTarget.setPointerCapture(event.pointerId); return; }
    if (tool === 'eyedropper') { pickColor(event); return; } if (activeLayerLocked) return; event.currentTarget.setPointerCapture(event.pointerId);
    const start = point(event); if (tool === 'move') { moveStart.current = start; moveEnd.current = start; return; }
    const shape = (['line', 'rectangle', 'ellipse', 'arrow', 'triangle'] as CanvasTool[]).includes(tool) ? tool as StrokeShape : 'freehand';
    const stroke = { id: crypto.randomUUID(), tool: tool === 'eraser' || tool === 'fill' ? tool : 'pencil', color, size, points: [start], at: 0, brush, shape, opacity: opacity / 100, smoothing: smoothing / 100 } satisfies Stroke;
    if (tool === 'fill') { commitStroke(stroke); return; } if (shape !== 'freehand') stroke.points.push(start); current.current = stroke; render();
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch' && touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchGesture.current && touches.current.size >= 2) { const pair = [...touches.current.values()]; const next = gestureSnapshot(pair[0]!, pair[1]!, touchGesture.current.viewport); const start = touchGesture.current; onViewportChange?.({ zoom: clamp(start.viewport.zoom * next.distance / Math.max(1, start.distance), .25, 8), rotation: normalizeRotation(start.viewport.rotation + (next.angle - start.angle) * 180 / Math.PI), panX: start.viewport.panX + next.centerX - start.centerX, panY: start.viewport.panY + next.centerY - start.centerY }); return; }
    }
    if (panDrag.current?.pointerId === event.pointerId) { const start = panDrag.current; onViewportChange?.({ ...start.viewport, panX: start.viewport.panX + event.clientX - start.clientX, panY: start.viewport.panY + event.clientY - start.clientY }); return; }
    if (moveStart.current) { moveEnd.current = point(event); return; }
    if (!current.current) return; const next = point(event);
    if (current.current.shape === 'freehand' && current.current.points.length >= MAX_GESTURE_POINTS) current.current.points = sampleStrokePoints(current.current.points, Math.floor(MAX_GESTURE_POINTS / 2));
    if (current.current.shape && current.current.shape !== 'freehand') current.current.points[1] = next;
    else { const previous = current.current.points.at(-1)!; if (Math.hypot(next.x - previous.x, next.y - previous.y) < .001) return; current.current.points.push(next); }
    render(); const now = performance.now();
    if (onPreview && now - lastPreview.current >= 40) { lastPreview.current = now; onPreview({ ...current.current, points: transportPointLimit ? sampleStrokePoints(current.current.points, transportPointLimit) : [...current.current.points] }); }
  };
  const commitStroke = (stroke: Stroke) => {
    const send = (value: Stroke) => (transportPointLimit ? splitStrokeForTransport(value, transportPointLimit) : [value]).forEach((segment) => onStroke?.(segment));
    send(stroke); if (symmetry === 'none' || stroke.tool === 'fill') return;
    send({ ...stroke, id: crypto.randomUUID(), points: stroke.points.map((point) => symmetry === 'vertical' ? { ...point, x: 1 - point.x } : { ...point, y: 1 - point.y }) });
  };
  const up = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') { touches.current.delete(event.pointerId); if (touchGesture.current) { if (touches.current.size < 2) touchGesture.current = null; current.current = null; render(); return; } }
    if (panDrag.current?.pointerId === event.pointerId) { panDrag.current = null; return; }
    if (moveStart.current && moveEnd.current) { onLayerTranslate?.(moveEnd.current.x - moveStart.current.x, moveEnd.current.y - moveStart.current.y); moveStart.current = null; moveEnd.current = null; return; }
    if (!current.current) return; const stroke = current.current; current.current = null; commitStroke(stroke);
  };
  const chooseBrush = (value: BrushStyle) => { setBrush(value); setTool('pencil'); };
  const saveCustomColor = () => setCustomColors((items) => items.includes(color.toLowerCase()) || items.length >= 24 ? items : [...items, color.toLowerCase()]);
  const wheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!active || !onViewportChange || !(event.target instanceof Node) || !boardRef.current?.contains(event.target)) return; event.preventDefault();
    if (event.shiftKey) { onViewportChange({ ...viewport, rotation: normalizeRotation(viewport.rotation + (event.deltaY > 0 ? 5 : -5)) }); return; }
    const factor = Math.exp(-event.deltaY * .0015); onViewportChange({ ...viewport, zoom: clamp(viewport.zoom * factor, .25, 8) });
  };

  return <div className={`canvas-shell ${active ? 'is-active' : ''} ${expert ? 'has-expert-tools' : ''} ${arenaTools ? 'has-arena-tools' : ''} ${expertPanelCollapsed ? 'expert-is-collapsed' : ''} ${panMode ? 'viewport-pan-mode' : ''} ${activeLayerLocked ? 'layer-is-locked' : ''}`} onWheel={wheel}>
    {active && <div className={`tool-rail ${expert ? 'pro-tool-rail' : arenaTools ? 'arena-tool-rail' : ''}`} aria-label="Drawing tools">
      <button className={tool === 'pencil' ? 'selected' : ''} onClick={() => setTool('pencil')} title="Brush (B)">✎<small>brush</small></button>
      <button className={tool === 'eraser' ? 'selected' : ''} onClick={() => setTool('eraser')} title="Eraser (E)">⌫<small>eraser</small></button>
      {(expert || arenaTools) && <><button className={tool === 'fill' ? 'selected' : ''} onClick={() => setTool('fill')} title="Fill (F)">◒<small>fill</small></button>
        <button className={tool === 'eyedropper' ? 'selected' : ''} onClick={() => setTool('eyedropper')} title="Eyedropper (I)">◉<small>sample</small></button>
        <button className={tool === 'move' ? 'selected' : ''} onClick={() => setTool('move')} title="Move drawing (V)">✥<small>move</small></button></>}
      {expert && <><span className="rail-line"/>
        <button className={tool === 'line' ? 'selected' : ''} onClick={() => setTool('line')}>╱<small>line</small></button>
        <button className={tool === 'rectangle' ? 'selected' : ''} onClick={() => setTool('rectangle')}>□<small>rect</small></button>
        <button className={tool === 'ellipse' ? 'selected' : ''} onClick={() => setTool('ellipse')}>○<small>ellipse</small></button>
        <button className={tool === 'arrow' ? 'selected' : ''} onClick={() => setTool('arrow')}>➜<small>arrow</small></button>
        <button className={tool === 'triangle' ? 'selected' : ''} onClick={() => setTool('triangle')}>△<small>triangle</small></button><span className="rail-line"/>
        <button className={showGrid ? 'selected utility' : 'utility'} onClick={() => setShowGrid((value) => !value)}>#<small>grid</small></button>
        <button className={symmetry !== 'none' ? 'selected utility' : 'utility'} onClick={() => setSymmetry((value) => value === 'none' ? 'vertical' : value === 'vertical' ? 'horizontal' : 'none')} title={`Symmetry: ${symmetry}`}>↔<small>{symmetry === 'none' ? 'mirror' : symmetry}</small></button></>}
      <span className="rail-line"/><button onClick={onUndo} title="Undo (Ctrl/Cmd + Z)">↶<small>undo</small></button><button onClick={onClear}>×<small>clear</small></button>
    </div>}
    {active && expert && <aside id="studio-expert-panel" className="expert-panel" aria-label="Expert brush controls">
      <header><div><small>ULTIMATE UTENSILS</small><b>{tool === 'pencil' ? BRUSHES.find((item) => item.id === brush)?.label : tool}</b></div><span>FREE</span><button className="panel-collapse-button" onClick={onToggleExpertPanel} aria-label="Collapse brush controls" title="Collapse brush controls">‹</button></header>
      <section><label>BRUSH LIBRARY</label><div className="brush-library">{BRUSHES.map((item) => <button className={tool === 'pencil' && brush === item.id ? 'active' : ''} onClick={() => chooseBrush(item.id)} key={item.id}><i className={`brush-mark ${item.id}`}/><span><b>{item.label}</b><small>{item.detail}</small></span></button>)}</div></section>
      <section className="palette-section"><label>COLOR PALETTE</label><div className="pro-colors"><input type="color" value={color} onChange={(event) => { setColor(event.target.value); setTool('pencil'); }} aria-label="Custom brush color"/><code>{color.toUpperCase()}</code><button onClick={saveCustomColor} disabled={customColors.length >= 24 || customColors.includes(color.toLowerCase())}>＋ SAVE</button></div><small className="palette-label">8 ESSENTIALS</small><div className="swatches">{COMMON_COLORS.map((value) => <button aria-label={`Use ${value}`} className={color.toLowerCase() === value ? 'selected' : ''} style={{ background: value }} onClick={() => { setColor(value); setTool('pencil'); }} key={value}/>)}</div><div className="custom-palette-heading"><small>MY COLORS</small><b>{customColors.length}/24</b></div><div className="custom-palette">{customColors.map((value) => <div className="custom-swatch" key={value}><button aria-label={`Use saved color ${value}`} className={color.toLowerCase() === value ? 'selected' : ''} style={{ background: value }} onClick={() => { setColor(value); setTool('pencil'); }}/><button className="remove-custom" aria-label={`Remove saved color ${value}`} onClick={() => setCustomColors((items) => items.filter((item) => item !== value))}>×</button></div>)}{!customColors.length && <span>Save any picker color here.</span>}</div></section>
      <section className="pro-sliders"><label>SIZE <b>{size}px</b><input type="range" min="1" max="160" value={size} onChange={(event) => setSize(Number(event.target.value))}/></label>
        <label>OPACITY <b>{opacity}%</b><input type="range" min="5" max="100" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))}/></label>
        <label>SMOOTHING <b>{smoothing}%</b><input type="range" min="0" max="100" value={smoothing} onChange={(event) => setSmoothing(Number(event.target.value))}/></label></section>
      <section className="canvas-assists"><label>CANVAS ASSISTS</label><button className={showGrid ? 'active' : ''} onClick={() => setShowGrid((value) => !value)}># Grid</button><button className={symmetry !== 'none' ? 'active' : ''} onClick={() => setSymmetry((value) => value === 'none' ? 'vertical' : value === 'vertical' ? 'horizontal' : 'none')}>↔ {symmetry === 'none' ? 'Symmetry off' : `${symmetry} symmetry`}</button></section>
      <footer><span>B</span> brush <span>V</span> move <span>E</span> erase <span>I</span> sample <span>⌘Z</span> undo</footer>
    </aside>}
    {active && expert && expertPanelCollapsed && <button className="expert-panel-tab" onClick={onToggleExpertPanel} aria-label="Open brush controls"><span>✎</span><b>UTENSILS</b></button>}
    <div className={`canvas-board ${showGrid ? 'show-grid' : ''}`} ref={boardRef} style={expert ? { aspectRatio: `${width} / ${height}`, transform: `translate(${viewport.panX}px, ${viewport.panY}px) rotate(${viewport.rotation}deg) scale(${viewport.zoom})` } : undefined}><canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label={active ? 'Drawing canvas' : 'Live drawing'} />{showGrid && <div className="canvas-grid" aria-hidden="true"/>}{symmetry !== 'none' && <div className={`symmetry-guide ${symmetry}`} aria-hidden="true"/>}{activeLayerLocked && <div className="canvas-lock-badge">▣ LAYER LOCKED</div>}{expert && <div className="canvas-dimensions" aria-hidden="true">{width} × {height}</div>}</div>
    {active && !expert && <div className={`canvas-controls ${arenaTools ? 'arena-canvas-controls' : ''}`}>{arenaTools && <label className="arena-brush-picker">BRUSH<select value={brush} onChange={(event) => chooseBrush(event.target.value as BrushStyle)}>{BRUSHES.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>}<div className="swatches">{COMMON_COLORS.map((value) => <button aria-label={`Use ${value}`} className={color.toLowerCase() === value ? 'selected' : ''} style={{ background: value }} onClick={() => { setColor(value); setTool('pencil'); }} key={value}/>)}</div>{arenaTools && <input className="arena-color-picker" type="color" value={color} onChange={(event) => { setColor(event.target.value); setTool('pencil'); }} aria-label="Pick drawing color"/>}<label>Stroke <input type="range" min="2" max={arenaTools ? 48 : 18} value={size} onChange={(event) => setSize(Number(event.target.value))}/><b>{size}</b></label></div>}
  </div>;
});

export function screenToCanvasCoordinates(clientX: number, clientY: number, centerX: number, centerY: number, boardWidth: number, boardHeight: number, viewport: CanvasViewport): { x: number; y: number } {
  const dx = clientX - centerX; const dy = clientY - centerY; const radians = -viewport.rotation * Math.PI / 180;
  const rotatedX = dx * Math.cos(radians) - dy * Math.sin(radians); const rotatedY = dx * Math.sin(radians) + dy * Math.cos(radians);
  return { x: clamp((rotatedX / viewport.zoom + boardWidth / 2) / boardWidth, 0, 1), y: clamp((rotatedY / viewport.zoom + boardHeight / 2) / boardHeight, 0, 1) };
}

function screenToCanvasPoint(clientX: number, clientY: number, board: HTMLDivElement, viewport: CanvasViewport): { x: number; y: number } {
  const rect = board.getBoundingClientRect(); return screenToCanvasCoordinates(clientX, clientY, rect.left + rect.width / 2, rect.top + rect.height / 2, board.clientWidth, board.clientHeight, viewport);
}

function gestureSnapshot(first: { x: number; y: number }, second: { x: number; y: number }, viewport: CanvasViewport) { return { distance: Math.hypot(second.x - first.x, second.y - first.y), angle: Math.atan2(second.y - first.y, second.x - first.x), centerX: (first.x + second.x) / 2, centerY: (first.y + second.y) / 2, viewport }; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function normalizeRotation(value: number): number { return ((value + 180) % 360 + 360) % 360 - 180; }

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number, ratio: number, layered: boolean) {
  if (!stroke.points.length) return; context.save();
  if (stroke.tool === 'eraser') context.globalCompositeOperation = layered ? 'destination-out' : 'source-over';
  if (stroke.tool === 'fill') { context.globalAlpha = stroke.opacity ?? 1; context.fillStyle = stroke.color; context.fillRect(0, 0, width, height); context.restore(); return; }
  const brush = stroke.tool === 'eraser' ? 'ink' : stroke.brush ?? 'pencil'; const profile = BRUSH_RENDER_PROFILES[brush]; const color = stroke.tool === 'eraser' ? '#f4f0e8' : stroke.color;
  const baseSize = stroke.size * ratio; const pressure = stroke.points.reduce((sum, point) => sum + (point.pressure ?? .5), 0) / stroke.points.length;
  context.strokeStyle = color; context.fillStyle = color; context.lineJoin = brush === 'pixel' ? 'miter' : 'round'; context.lineCap = brush === 'marker' || brush === 'pixel' || brush === 'calligraphy' ? 'butt' : 'round';
  context.lineWidth = baseSize * profile.width * (brush === 'technical' ? 1 : .72 + pressure * .56); context.globalAlpha = stroke.tool === 'eraser' ? 1 : (stroke.opacity ?? 1) * profile.alpha;
  const first = stroke.points[0]!;
  if (stroke.shape && stroke.shape !== 'freehand') { drawShape(context, stroke, width, height, ratio); context.restore(); return; }
  if (stroke.points.length === 1) { drawBrushDot(context, brush, first.x * width, first.y * height, baseSize, color); context.restore(); return; }

  if (brush === 'pixel') {
    const step = Math.max(2 * ratio, baseSize * .7); const points = sampleStrokePoints(stroke.points, Math.min(900, stroke.points.length));
    for (const point of points) { const x = Math.round(point.x * width / step) * step; const y = Math.round(point.y * height / step) * step; context.fillRect(x - step / 2, y - step / 2, step, step); }
  } else if (brush === 'airbrush') {
    context.shadowColor = color; context.shadowBlur = baseSize * 1.6; context.lineWidth = baseSize * 1.8; traceStroke(context, stroke, width, height); context.stroke();
    context.shadowBlur = baseSize * .8; const points = sampleStrokePoints(stroke.points, Math.min(700, stroke.points.length));
    points.forEach((point, index) => { for (let dust = 0; dust < 4; dust += 1) { const angle = noise(index, dust) * Math.PI * 2; const radius = noise(index + 31, dust + 7) * baseSize * 1.7; const dot = Math.max(.45 * ratio, noise(index + 91, dust + 2) * baseSize * .18); context.beginPath(); context.arc(point.x * width + Math.cos(angle) * radius, point.y * height + Math.sin(angle) * radius, dot, 0, Math.PI * 2); context.fill(); } });
  } else if (brush === 'charcoal') {
    context.setLineDash([Math.max(1, baseSize * .42), Math.max(1, baseSize * .16)]); context.lineWidth = baseSize * 1.05;
    for (const offset of [-.18, 0, .21]) { context.beginPath(); traceStroke(context, stroke, width, height, offset * baseSize, Math.sin(offset * 23) * baseSize * .16); context.stroke(); }
    context.setLineDash([]); scatterTexture(context, stroke, width, height, baseSize, 1.35, 3);
  } else if (brush === 'pastel') {
    context.lineWidth = baseSize * 1.25; context.setLineDash([Math.max(1,baseSize * .3),Math.max(1,baseSize * .08)]); traceStroke(context, stroke, width, height); context.stroke(); context.setLineDash([]); scatterTexture(context, stroke, width, height, baseSize, 1.05, 5);
  } else if (brush === 'watercolor') {
    context.lineCap = 'round'; context.shadowColor = color; context.shadowBlur = baseSize * .35;
    for (const [scale, x, y] of [[2.05,-.18,.08],[1.65,.16,-.13],[1.2,0,.16]] as const) { context.lineWidth = baseSize * scale; context.beginPath(); traceStroke(context, stroke, width, height, x * baseSize, y * baseSize); context.stroke(); }
  } else if (brush === 'calligraphy') {
    context.lineCap = 'butt'; context.lineJoin = 'bevel'; context.lineWidth = baseSize * (1.05 + pressure); traceStroke(context, stroke, width, height); context.stroke();
    context.globalAlpha *= .52; context.lineWidth = Math.max(ratio, baseSize * .22); context.strokeStyle = '#ffffff'; context.beginPath(); traceStroke(context, stroke, width, height, baseSize * .28, -baseSize * .28); context.stroke();
  } else if (brush === 'neon') {
    context.globalAlpha *= .72; context.shadowColor = color; context.shadowBlur = baseSize * 2.4; context.lineWidth = baseSize * 1.45; traceStroke(context, stroke, width, height); context.stroke();
    context.globalAlpha = stroke.opacity ?? 1; context.shadowBlur = baseSize * .7; context.lineWidth = Math.max(1.2 * ratio, baseSize * .42); context.strokeStyle = '#ffffff'; context.beginPath(); traceStroke(context, stroke, width, height); context.stroke();
  } else if (brush === 'marker') {
    context.globalCompositeOperation = stroke.tool === 'eraser' ? context.globalCompositeOperation : 'multiply'; context.lineWidth = baseSize * 1.55; traceStroke(context, stroke, width, height); context.stroke();
    context.globalAlpha *= .55; context.lineWidth = baseSize * 1.12; context.beginPath(); traceStroke(context, stroke, width, height, baseSize * .11, 0); context.stroke();
  } else if (brush === 'pencil') {
    context.lineWidth = baseSize * (.42 + pressure * .52); traceStroke(context, stroke, width, height); context.stroke();
    context.globalAlpha *= .28; context.lineWidth = Math.max(.55 * ratio, baseSize * .18); for (const offset of [-.22,.25]) { context.beginPath(); traceStroke(context, stroke, width, height, offset * baseSize, offset * baseSize * .35); context.stroke(); }
  } else {
    context.lineWidth = baseSize * (brush === 'technical' ? .42 : .72 + pressure * .58); traceStroke(context, stroke, width, height); context.stroke();
    if (brush === 'ink') { context.beginPath(); context.arc(first.x * width, first.y * height, context.lineWidth * .34, 0, Math.PI * 2); context.fill(); }
  }
  context.restore();
}

function traceStroke(context: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number, offsetX = 0, offsetY = 0): void {
  const first = stroke.points[0]!; const last = stroke.points.at(-1)!; context.beginPath(); context.moveTo(first.x * width + offsetX, first.y * height + offsetY);
  if ((stroke.smoothing ?? 0) > .08 && stroke.points.length > 2) { for (let index = 1; index < stroke.points.length - 1; index += 1) { const point = stroke.points[index]!; const next = stroke.points[index + 1]!; context.quadraticCurveTo(point.x * width + offsetX, point.y * height + offsetY, (point.x + next.x) * width / 2 + offsetX, (point.y + next.y) * height / 2 + offsetY); } context.lineTo(last.x * width + offsetX, last.y * height + offsetY); }
  else for (const point of stroke.points.slice(1)) context.lineTo(point.x * width + offsetX, point.y * height + offsetY);
}

function drawShape(context: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number, ratio: number): void {
  const first = stroke.points[0]!; const last = stroke.points.at(-1)!;
  if (stroke.shape === 'rectangle') { context.strokeRect(first.x * width, first.y * height, (last.x - first.x) * width, (last.y - first.y) * height); return; }
  if (stroke.shape === 'ellipse') { context.beginPath(); context.ellipse((first.x + last.x) * width / 2, (first.y + last.y) * height / 2, Math.abs(last.x - first.x) * width / 2, Math.abs(last.y - first.y) * height / 2, 0, 0, Math.PI * 2); context.stroke(); return; }
  if (stroke.shape === 'triangle') { context.beginPath(); context.moveTo((first.x + last.x) * width / 2, first.y * height); context.lineTo(last.x * width, last.y * height); context.lineTo(first.x * width, last.y * height); context.closePath(); context.stroke(); return; }
  const x1 = first.x * width; const y1 = first.y * height; const x2 = last.x * width; const y2 = last.y * height; context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2);
  if (stroke.shape === 'arrow') { const angle = Math.atan2(y2 - y1, x2 - x1); const head = Math.max(12 * ratio, stroke.size * ratio * 3); context.moveTo(x2, y2); context.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6)); context.moveTo(x2, y2); context.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6)); }
  context.stroke();
}

function drawBrushDot(context: CanvasRenderingContext2D, brush: BrushStyle, x: number, y: number, size: number, color: string): void {
  if (brush === 'pixel') { context.fillRect(x - size / 2, y - size / 2, size, size); return; }
  if (brush === 'neon') { context.shadowColor = color; context.shadowBlur = size * 2; context.beginPath(); context.arc(x, y, size * .62, 0, Math.PI * 2); context.fill(); context.fillStyle = '#fff'; context.beginPath(); context.arc(x, y, size * .2, 0, Math.PI * 2); context.fill(); return; }
  context.beginPath(); context.arc(x, y, size * BRUSH_RENDER_PROFILES[brush].width / 2, 0, Math.PI * 2); context.fill();
}

function scatterTexture(context: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number, size: number, spread: number, density: number): void {
  const points = sampleStrokePoints(stroke.points, Math.min(650, stroke.points.length));
  points.forEach((point, index) => { for (let grain = 0; grain < density; grain += 1) { const angle = noise(index, grain) * Math.PI * 2; const radius = noise(index + 17, grain + 13) * size * spread; const dot = Math.max(.35, noise(index + 61, grain + 5) * size * .11); context.beginPath(); context.arc(point.x * width + Math.cos(angle) * radius, point.y * height + Math.sin(angle) * radius, dot, 0, Math.PI * 2); context.fill(); } });
}

function noise(value: number, salt: number): number { const raw = Math.sin(value * 12.9898 + salt * 78.233) * 43_758.5453; return raw - Math.floor(raw); }
