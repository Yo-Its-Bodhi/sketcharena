import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrushStyle, DrawTool, Stroke, StrokeShape } from '@sketch-arena/protocol';
import { sampleStrokePoints, splitStrokeForTransport } from './strokeTransport';

export type LayerBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';
export interface CanvasLayer { id: string; name: string; strokes: Stroke[]; visible: boolean; opacity: number; locked: boolean; blendMode: LayerBlendMode; }
interface Props {
  strokes: Stroke[]; active: boolean; expert?: boolean; layers?: CanvasLayer[]; activeLayerId?: string;
  width?: number; height?: number; onStroke?: (stroke: Stroke) => void; onPreview?: (stroke: Stroke) => void;
  onClear?: () => void; onUndo?: () => void; activeLayerLocked?: boolean; onLayerTranslate?: (x: number, y: number) => void;
  transportPointLimit?: number;
}
type CanvasTool = DrawTool | 'eyedropper' | 'move' | 'line' | 'rectangle' | 'ellipse' | 'arrow' | 'triangle';
interface LayerRenderCache { canvas: HTMLCanvasElement; strokes: Stroke[]; pixelWidth: number; pixelHeight: number; ratio: number; }
interface PreviewSurface { canvas: HTMLCanvasElement; pixelWidth: number; pixelHeight: number; }
const COMMON_COLORS = ['#000000', '#ffffff', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6'];
const MAX_GESTURE_POINTS = 7_000;
const BRUSHES: Array<{ id: BrushStyle; label: string; detail: string }> = [
  { id: 'pencil', label: 'Pencil', detail: 'Crisp sketch' }, { id: 'ink', label: 'Inker', detail: 'Clean + bold' },
  { id: 'marker', label: 'Marker', detail: 'Translucent' }, { id: 'airbrush', label: 'Airbrush', detail: 'Soft build-up' },
  { id: 'charcoal', label: 'Charcoal', detail: 'Dry texture' }, { id: 'technical', label: 'Technical', detail: 'Precision line' },
  { id: 'watercolor', label: 'Watercolor', detail: 'Soft wash' }, { id: 'pastel', label: 'Pastel', detail: 'Powder texture' },
  { id: 'pixel', label: 'Pixel', detail: 'Hard square' }, { id: 'calligraphy', label: 'Calligraphy', detail: 'Elegant edge' },
  { id: 'neon', label: 'Neon', detail: 'Electric glow' },
];

function loadCustomColors(): string[] {
  try { const value = JSON.parse(localStorage.getItem('sketch-arena-custom-colors') ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && /^#[0-9a-f]{6}$/i.test(item)).slice(0, 24) : []; }
  catch { return []; }
}

export function Canvas({ strokes, active, expert = false, layers, activeLayerId, width = 2400, height = 2400, onStroke, onPreview, onClear, onUndo, activeLayerLocked = false, onLayerTranslate, transportPointLimit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null); const boardRef = useRef<HTMLDivElement>(null);
  const current = useRef<Stroke | null>(null); const lastPreview = useRef(0); const moveStart = useRef<{ x: number; y: number } | null>(null); const moveEnd = useRef<{ x: number; y: number } | null>(null);
  const layerRenderCache = useRef<Map<string, LayerRenderCache>>(new Map()); const previewSurface = useRef<PreviewSurface | null>(null);
  const equippedBrush = expert ? localStorage.getItem('sketch-equipped-brush') : null;
  const [tool, setTool] = useState<CanvasTool>('pencil'); const [brush, setBrush] = useState<BrushStyle>(() => equippedBrush === 'neon-panic-brush' ? 'neon' : 'pencil');
  const [color, setColor] = useState(() => equippedBrush === 'neon-panic-brush' ? '#8b5cf6' : equippedBrush === 'panic-pencil' ? '#e54b3e' : '#171514'); const [size, setSize] = useState(6);
  const [opacity, setOpacity] = useState(100); const [smoothing, setSmoothing] = useState(45);
  const [customColors, setCustomColors] = useState<string[]>(loadCustomColors);
  const [showGrid, setShowGrid] = useState(false); const [symmetry, setSymmetry] = useState<'none' | 'vertical' | 'horizontal'>('none');

  const render = useCallback(() => {
    const canvas = canvasRef.current; const board = boardRef.current; if (!canvas || !board) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const ratio = window.devicePixelRatio || 1; const rect = board.getBoundingClientRect();
    const pixelWidth = Math.max(1, Math.floor(rect.width * ratio)); const pixelHeight = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; context.fillStyle = '#f4f0e8'; context.fillRect(0, 0, pixelWidth, pixelHeight);
    if (layers) {
      const retainedLayerIds = new Set(layers.map((layer) => layer.id));
      for (const id of layerRenderCache.current.keys()) if (!retainedLayerIds.has(id)) layerRenderCache.current.delete(id);
      for (const layer of layers) {
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
  useEffect(() => { const listener = () => render(); window.addEventListener('resize', listener); return () => window.removeEventListener('resize', listener); }, [render]);
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); onUndo?.(); return; }
      const key = event.key.toLowerCase(); if (key === 'p' || key === 'b') setTool('pencil'); if (key === 'e') setTool('eraser');
      if (key === 'f') setTool('fill'); if (key === 'i') setTool('eyedropper'); if (key === 'v') setTool('move');
      if (key === 'l') setTool('line'); if (key === 'r') setTool('rectangle'); if (key === 'o') setTool('ellipse');
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [active, onUndo]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)), pressure: event.pressure > 0 ? event.pressure : .5 };
  };
  const pickColor = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return; const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - rect.left) / rect.width * canvas.width)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - rect.top) / rect.height * canvas.height)));
    const pixel = canvas.getContext('2d')?.getImageData(x, y, 1, 1).data; if (!pixel) return;
    setColor(`#${[pixel[0], pixel[1], pixel[2]].map((value) => value!.toString(16).padStart(2, '0')).join('')}`); setTool('pencil');
  };
  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active) return; if (tool === 'eyedropper') { pickColor(event); return; } if (activeLayerLocked) return; event.currentTarget.setPointerCapture(event.pointerId);
    const start = point(event); if (tool === 'move') { moveStart.current = start; moveEnd.current = start; return; }
    const shape = (['line', 'rectangle', 'ellipse', 'arrow', 'triangle'] as CanvasTool[]).includes(tool) ? tool as StrokeShape : 'freehand';
    const stroke = { id: crypto.randomUUID(), tool: tool === 'eraser' || tool === 'fill' ? tool : 'pencil', color, size, points: [start], at: 0, brush, shape, opacity: opacity / 100, smoothing: smoothing / 100 } satisfies Stroke;
    if (tool === 'fill') { commitStroke(stroke); return; } if (shape !== 'freehand') stroke.points.push(start); current.current = stroke; render();
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
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
  const up = () => {
    if (moveStart.current && moveEnd.current) { onLayerTranslate?.(moveEnd.current.x - moveStart.current.x, moveEnd.current.y - moveStart.current.y); moveStart.current = null; moveEnd.current = null; return; }
    if (!current.current) return; const stroke = current.current; current.current = null; commitStroke(stroke);
  };
  const chooseBrush = (value: BrushStyle) => { setBrush(value); setTool('pencil'); };
  const saveCustomColor = () => setCustomColors((items) => items.includes(color.toLowerCase()) || items.length >= 24 ? items : [...items, color.toLowerCase()]);

  return <div className={`canvas-shell ${active ? 'is-active' : ''} ${expert ? 'has-expert-tools' : ''} ${activeLayerLocked ? 'layer-is-locked' : ''}`}>
    {active && <div className={`tool-rail ${expert ? 'pro-tool-rail' : ''}`} aria-label="Drawing tools">
      <button className={tool === 'pencil' ? 'selected' : ''} onClick={() => setTool('pencil')} title="Brush (B)">✎<small>brush</small></button>
      <button className={tool === 'eraser' ? 'selected' : ''} onClick={() => setTool('eraser')} title="Eraser (E)">⌫<small>eraser</small></button>
      {expert && <><button className={tool === 'fill' ? 'selected' : ''} onClick={() => setTool('fill')} title="Fill (F)">◒<small>fill</small></button>
        <button className={tool === 'eyedropper' ? 'selected' : ''} onClick={() => setTool('eyedropper')} title="Eyedropper (I)">◉<small>sample</small></button>
        <button className={tool === 'move' ? 'selected' : ''} onClick={() => setTool('move')} title="Move active layer (V)">✥<small>move</small></button><span className="rail-line"/>
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
      <header><div><small>ULTIMATE UTENSILS</small><b>{tool === 'pencil' ? BRUSHES.find((item) => item.id === brush)?.label : tool}</b></div><span>FREE</span></header>
      <section><label>BRUSH LIBRARY</label><div className="brush-library">{BRUSHES.map((item) => <button className={tool === 'pencil' && brush === item.id ? 'active' : ''} onClick={() => chooseBrush(item.id)} key={item.id}><i className={`brush-mark ${item.id}`}/><span><b>{item.label}</b><small>{item.detail}</small></span></button>)}</div></section>
      <section className="palette-section"><label>COLOR PALETTE</label><div className="pro-colors"><input type="color" value={color} onChange={(event) => { setColor(event.target.value); setTool('pencil'); }} aria-label="Custom brush color"/><code>{color.toUpperCase()}</code><button onClick={saveCustomColor} disabled={customColors.length >= 24 || customColors.includes(color.toLowerCase())}>＋ SAVE</button></div><small className="palette-label">8 ESSENTIALS</small><div className="swatches">{COMMON_COLORS.map((value) => <button aria-label={`Use ${value}`} className={color.toLowerCase() === value ? 'selected' : ''} style={{ background: value }} onClick={() => { setColor(value); setTool('pencil'); }} key={value}/>)}</div><div className="custom-palette-heading"><small>MY COLORS</small><b>{customColors.length}/24</b></div><div className="custom-palette">{customColors.map((value) => <div className="custom-swatch" key={value}><button aria-label={`Use saved color ${value}`} className={color.toLowerCase() === value ? 'selected' : ''} style={{ background: value }} onClick={() => { setColor(value); setTool('pencil'); }}/><button className="remove-custom" aria-label={`Remove saved color ${value}`} onClick={() => setCustomColors((items) => items.filter((item) => item !== value))}>×</button></div>)}{!customColors.length && <span>Save any picker color here.</span>}</div></section>
      <section className="pro-sliders"><label>SIZE <b>{size}px</b><input type="range" min="1" max="160" value={size} onChange={(event) => setSize(Number(event.target.value))}/></label>
        <label>OPACITY <b>{opacity}%</b><input type="range" min="5" max="100" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))}/></label>
        <label>SMOOTHING <b>{smoothing}%</b><input type="range" min="0" max="100" value={smoothing} onChange={(event) => setSmoothing(Number(event.target.value))}/></label></section>
      <section className="canvas-assists"><label>CANVAS ASSISTS</label><button className={showGrid ? 'active' : ''} onClick={() => setShowGrid((value) => !value)}># Grid</button><button className={symmetry !== 'none' ? 'active' : ''} onClick={() => setSymmetry((value) => value === 'none' ? 'vertical' : value === 'vertical' ? 'horizontal' : 'none')}>↔ {symmetry === 'none' ? 'Symmetry off' : `${symmetry} symmetry`}</button></section>
      <footer><span>B</span> brush <span>V</span> move <span>E</span> erase <span>I</span> sample <span>⌘Z</span> undo</footer>
    </aside>}
    <div className={`canvas-board ${showGrid ? 'show-grid' : ''}`} ref={boardRef} style={expert ? { aspectRatio: `${width} / ${height}` } : undefined}><canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label={active ? 'Drawing canvas' : 'Live drawing'} />{showGrid && <div className="canvas-grid" aria-hidden="true"/>}{symmetry !== 'none' && <div className={`symmetry-guide ${symmetry}`} aria-hidden="true"/>}{activeLayerLocked && <div className="canvas-lock-badge">▣ LAYER LOCKED</div>}{expert && <div className="canvas-dimensions" aria-hidden="true">{width} × {height}</div>}</div>
    {active && !expert && <div className="canvas-controls"><div className="swatches">{COMMON_COLORS.map((value) => <button aria-label={`Use ${value}`} className={color.toLowerCase() === value ? 'selected' : ''} style={{ background: value }} onClick={() => { setColor(value); setTool('pencil'); }} key={value}/>)}</div><label>Stroke <input type="range" min="2" max="18" value={size} onChange={(event) => setSize(Number(event.target.value))}/><b>{size}</b></label></div>}
  </div>;
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number, ratio: number, layered: boolean) {
  if (!stroke.points.length) return; context.save();
  if (stroke.tool === 'eraser') context.globalCompositeOperation = layered ? 'destination-out' : 'source-over';
  if (stroke.tool === 'fill') { context.globalAlpha = stroke.opacity ?? 1; context.fillStyle = stroke.color; context.fillRect(0, 0, width, height); context.restore(); return; }
  const brush = stroke.brush ?? 'pencil'; const eraseColor = '#f4f0e8'; context.lineCap = brush === 'pixel' || brush === 'calligraphy' ? 'butt' : 'round'; context.lineJoin = brush === 'pixel' ? 'miter' : 'round';
  const widthScale = brush === 'pencil' ? .72 : brush === 'technical' ? .45 : brush === 'calligraphy' ? 1.45 : 1;
  context.lineWidth = stroke.size * ratio * widthScale; context.strokeStyle = stroke.tool === 'eraser' ? eraseColor : stroke.color; context.fillStyle = stroke.tool === 'eraser' ? eraseColor : stroke.color;
  const brushAlpha = brush === 'marker' ? .38 : brush === 'airbrush' ? .22 : brush === 'watercolor' ? .3 : brush === 'pastel' ? .64 : brush === 'charcoal' ? .72 : 1;
  context.globalAlpha = stroke.tool === 'eraser' ? 1 : (stroke.opacity ?? 1) * brushAlpha;
  if (brush === 'airbrush' || brush === 'watercolor' || brush === 'neon') { context.shadowColor = stroke.color; context.shadowBlur = stroke.size * ratio * (brush === 'neon' ? 1.25 : .8); }
  if (brush === 'charcoal' || brush === 'pastel') context.setLineDash([Math.max(1, stroke.size * ratio * .32), Math.max(1, stroke.size * ratio * .13)]);
  const first = stroke.points[0]!; const last = stroke.points.at(-1)!;
  if (stroke.shape === 'rectangle') { context.strokeRect(first.x * width, first.y * height, (last.x - first.x) * width, (last.y - first.y) * height); context.restore(); return; }
  if (stroke.shape === 'ellipse') { const x = (first.x + last.x) * width / 2; const y = (first.y + last.y) * height / 2; context.beginPath(); context.ellipse(x, y, Math.abs(last.x - first.x) * width / 2, Math.abs(last.y - first.y) * height / 2, 0, 0, Math.PI * 2); context.stroke(); context.restore(); return; }
  if (stroke.shape === 'triangle') { context.beginPath(); context.moveTo((first.x + last.x) * width / 2, first.y * height); context.lineTo(last.x * width, last.y * height); context.lineTo(first.x * width, last.y * height); context.closePath(); context.stroke(); context.restore(); return; }
  if (stroke.shape === 'arrow') { const x1 = first.x * width; const y1 = first.y * height; const x2 = last.x * width; const y2 = last.y * height; const angle = Math.atan2(y2 - y1, x2 - x1); const head = Math.max(12 * ratio, stroke.size * ratio * 3); context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.moveTo(x2, y2); context.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6)); context.moveTo(x2, y2); context.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6)); context.stroke(); context.restore(); return; }
  if (stroke.shape === 'line') { context.beginPath(); context.moveTo(first.x * width, first.y * height); context.lineTo(last.x * width, last.y * height); context.stroke(); context.restore(); return; }
  if (stroke.points.length === 1) { context.beginPath(); context.arc(first.x * width, first.y * height, stroke.size * ratio / 2, 0, Math.PI * 2); context.fill(); context.restore(); return; }
  context.beginPath(); context.moveTo(first.x * width, first.y * height); const smooth = stroke.smoothing ?? 0;
  if (smooth > .08 && stroke.points.length > 2) { for (let index = 1; index < stroke.points.length - 1; index += 1) { const point = stroke.points[index]!; const next = stroke.points[index + 1]!; context.quadraticCurveTo(point.x * width, point.y * height, (point.x + next.x) * width / 2, (point.y + next.y) * height / 2); } context.lineTo(last.x * width, last.y * height); }
  else for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height); context.stroke(); context.restore();
}
