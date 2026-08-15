import { useCallback, useEffect, useRef, useState } from 'react';
import type { DrawTool, Stroke } from '@sketch-arena/protocol';

interface Props { strokes: Stroke[]; active: boolean; expert?: boolean; onStroke?: (stroke: Stroke) => void; onPreview?: (stroke: Stroke) => void; onClear?: () => void; onUndo?: () => void; }
const COLORS = ['#171514', '#f4f0e8', '#ef476f', '#ffb703', '#27ae8a', '#2878ff', '#8b5cf6'];

export function Canvas({ strokes, active, expert = false, onStroke, onPreview, onClear, onUndo }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const current = useRef<Stroke | null>(null);
  const lastPreview = useRef(0);
  const [tool, setTool] = useState<DrawTool>('pencil');
  const [color, setColor] = useState('#171514');
  const [size, setSize] = useState(6);

  const render = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width * ratio)); const height = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.fillStyle = '#f4f0e8'; context.fillRect(0, 0, width, height);
    for (const stroke of strokes) drawStroke(context, stroke, width, height, ratio);
    if (current.current) drawStroke(context, current.current, width, height, ratio);
  }, [strokes]);

  useEffect(() => { render(); }, [render]);
  useEffect(() => { const listener = () => render(); window.addEventListener('resize', listener); return () => window.removeEventListener('resize', listener); }, [render]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active) return; event.currentTarget.setPointerCapture(event.pointerId);
    const stroke = { id: crypto.randomUUID(), tool, color, size, points: [point(event)], at: 0 } satisfies Stroke;
    if (tool === 'fill') { onStroke?.(stroke); return; }
    current.current = stroke; render();
  };
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!current.current || current.current.points.length >= 250) return;
    const next = point(event); const previous = current.current.points.at(-1)!;
    if (Math.hypot(next.x - previous.x, next.y - previous.y) < .0015) return;
    current.current.points.push(next); render();
    const now = performance.now();
    if (onPreview && now - lastPreview.current >= 40) { lastPreview.current = now; onPreview({ ...current.current, points: [...current.current.points] }); }
  };
  const up = () => { if (!current.current) return; const stroke = current.current; current.current = null; onStroke?.(stroke); };

  return <div className={`canvas-shell ${active ? 'is-active' : ''}`}>
    {active && <div className="tool-rail" aria-label="Drawing tools">
      {(['pencil', 'eraser'] as DrawTool[]).map((value) => <button className={tool === value ? 'selected' : ''} onClick={() => setTool(value)} key={value}>{value === 'pencil' ? '✎' : '⌫'}<small>{value}</small></button>)}
      {expert && <button className={tool === 'fill' ? 'selected' : ''} onClick={() => setTool('fill')}>◒<small>fill</small></button>}
      <span className="rail-line"/>
      <button onClick={onUndo}>↶<small>undo</small></button><button onClick={onClear}>×<small>clear</small></button>
    </div>}
    <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label={active ? 'Drawing canvas' : 'Live drawing'} />
    {active && <div className="canvas-controls">
      <div className="swatches">{COLORS.map((value) => <button aria-label={`Use ${value}`} className={color === value ? 'selected' : ''} style={{ background: value }} onClick={() => { setColor(value); setTool('pencil'); }} key={value}/>)}</div>
      <label>Stroke <input type="range" min="2" max={expert ? 36 : 18} value={size} onChange={(event) => setSize(Number(event.target.value))}/><b>{size}</b></label>
    </div>}
  </div>;
}

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, width: number, height: number, ratio: number) {
  if (!stroke.points.length) return;
  if (stroke.tool === 'fill') { context.save(); context.fillStyle = stroke.color; context.fillRect(0, 0, width, height); context.restore(); return; }
  context.save(); context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = stroke.size * ratio;
  if (stroke.tool === 'eraser') { context.globalCompositeOperation = 'source-over'; context.strokeStyle = '#f4f0e8'; }
  else context.strokeStyle = stroke.color;
  if (stroke.points.length === 1) { context.fillStyle = stroke.tool === 'eraser' ? '#f4f0e8' : stroke.color; context.beginPath(); context.arc(stroke.points[0]!.x * width, stroke.points[0]!.y * height, stroke.size * ratio / 2, 0, Math.PI * 2); context.fill(); context.restore(); return; }
  context.beginPath(); context.moveTo(stroke.points[0]!.x * width, stroke.points[0]!.y * height);
  for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height);
  context.stroke(); context.restore();
}
