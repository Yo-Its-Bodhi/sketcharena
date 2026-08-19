import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PromptCard, PromptDifficulty, PromptLibrarySummary, PromptMode } from '@sketch-arena/protocol';
import { WORDS } from '../words.js';

export const PROMPT_CATEGORIES = ['chaos', 'classic', 'animals', 'food', 'screen', 'music', 'places', 'crypto', 'legends'] as const;
export const PROMPT_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

export interface PromptRepository {
  list(): Promise<PromptCard[]>;
  create(input: Omit<PromptCard, 'id' | 'timesPlayed' | 'timesSolved' | 'averageSolveMs' | 'createdAt' | 'updatedAt'>): Promise<PromptCard>;
  update(id: string, patch: Partial<Pick<PromptCard, 'text' | 'category' | 'difficulty' | 'active' | 'seasonalTag'>>): Promise<PromptCard>;
  record(text: string, solved: number, totalSolveMs: number): Promise<void>;
}

export class MemoryPromptRepository implements PromptRepository {
  protected cards = defaultPromptCards();
  async list() { return this.cards.map((card) => ({ ...card })); }
  async create(input: Omit<PromptCard, 'id' | 'timesPlayed' | 'timesSolved' | 'averageSolveMs' | 'createdAt' | 'updatedAt'>) {
    if (this.cards.some((card) => key(card.text) === key(input.text))) throw new Error('That prompt already exists');
    const now = Date.now(); const card: PromptCard = { ...input, id: randomUUID(), timesPlayed: 0, timesSolved: 0, averageSolveMs: 0, createdAt: now, updatedAt: now };
    this.cards.push(card); return { ...card };
  }
  async update(id: string, patch: Partial<Pick<PromptCard, 'text' | 'category' | 'difficulty' | 'active' | 'seasonalTag'>>) {
    const card = this.cards.find((value) => value.id === id); if (!card) throw new Error('Prompt not found');
    if (patch.text && this.cards.some((value) => value.id !== id && key(value.text) === key(patch.text!))) throw new Error('That prompt already exists');
    Object.assign(card, patch, { updatedAt: Date.now() }); return { ...card };
  }
  async record(text: string, solved: number, totalSolveMs: number) { const card = this.cards.find((value) => key(value.text) === key(text)); if (!card) return; card.timesPlayed += 1; card.timesSolved += solved; card.averageSolveMs = card.timesSolved ? Math.round(((card.averageSolveMs * (card.timesSolved - solved)) + totalSolveMs) / card.timesSolved) : 0; card.updatedAt = Date.now(); }
}

export class PostgresPromptRepository implements PromptRepository {
  constructor(private readonly pool: Pool) {}
  async list(): Promise<PromptCard[]> { const result = await this.pool.query('select * from prompt_cards order by category,difficulty,text'); return result.rows.map(row); }
  async seedDefaults(): Promise<void> {
    const cards = defaultPromptCards();
    for (const card of cards) await this.pool.query(`insert into prompt_cards(id,text,text_key,category,difficulty,active,seasonal_tag,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(text_key) do nothing`, [card.id, card.text, key(card.text), card.category, card.difficulty, card.active, card.seasonalTag ?? null, new Date(card.createdAt), new Date(card.updatedAt)]);
  }
  async create(input: Omit<PromptCard, 'id' | 'timesPlayed' | 'timesSolved' | 'averageSolveMs' | 'createdAt' | 'updatedAt'>): Promise<PromptCard> {
    const result = await this.pool.query(`insert into prompt_cards(id,text,text_key,category,difficulty,active,seasonal_tag) values($1,$2,$3,$4,$5,$6,$7) returning *`, [randomUUID(), input.text, key(input.text), input.category, input.difficulty, input.active, input.seasonalTag ?? null]); return row(result.rows[0]);
  }
  async update(id: string, patch: Partial<Pick<PromptCard, 'text' | 'category' | 'difficulty' | 'active' | 'seasonalTag'>>): Promise<PromptCard> {
    const current = (await this.pool.query('select * from prompt_cards where id=$1', [id])).rows[0]; if (!current) throw new Error('Prompt not found');
    const next = { ...row(current), ...patch };
    const result = await this.pool.query(`update prompt_cards set text=$2,text_key=$3,category=$4,difficulty=$5,active=$6,seasonal_tag=$7,updated_at=now() where id=$1 returning *`, [id, next.text, key(next.text), next.category, next.difficulty, next.active, next.seasonalTag ?? null]); return row(result.rows[0]);
  }
  async record(text: string, solved: number, totalSolveMs: number): Promise<void> { await this.pool.query(`update prompt_cards set times_played=times_played+1,times_solved=times_solved+$2,total_solve_ms=total_solve_ms+$3,updated_at=now() where text_key=$1`, [key(text), solved, totalSolveMs]); }
}

export class PromptLibrary {
  private cards: PromptCard[] = [];
  constructor(private readonly repository: PromptRepository, private readonly clock: () => number = Date.now) {}
  async load(): Promise<void> { this.cards = await this.repository.list(); }
  summary(): PromptLibrarySummary {
    const active = this.cards.filter((card) => card.active); const byDifficulty = Object.fromEntries(PROMPT_DIFFICULTIES.map((difficulty) => [difficulty, active.filter((card) => card.difficulty === difficulty).length])) as Record<PromptDifficulty, number>;
    return { total: this.cards.length, active: active.length, dailySize: Math.min(60, active.length), rotationKey: utcDay(this.clock()), byDifficulty, categories: PROMPT_CATEGORIES.map((id) => ({ id, count: active.filter((card) => card.category === id).length })) };
  }
  list() { return this.cards.map((card) => ({ ...card })); }
  choose(mode: PromptMode, category: string, difficulty: PromptDifficulty | 'mixed', excluded: ReadonlySet<string>, random = Math.random): string {
    let pool = this.cards.filter((card) => card.active);
    if (mode === 'daily') pool = dailyCards(pool, this.clock());
    else if (mode === 'category') pool = pool.filter((card) => card.category === category);
    if (difficulty !== 'mixed') pool = pool.filter((card) => card.difficulty === difficulty);
    if (!pool.length) pool = this.cards.filter((card) => card.active);
    const fresh = pool.filter((card) => !excluded.has(card.text)); const choices = fresh.length ? fresh : pool;
    return choices[Math.floor(random() * choices.length)]?.text ?? 'dramatic potato';
  }
  async create(input: Omit<PromptCard, 'id' | 'timesPlayed' | 'timesSolved' | 'averageSolveMs' | 'createdAt' | 'updatedAt'>) { const value = await this.repository.create(input); await this.load(); return value; }
  async update(id: string, patch: Partial<Pick<PromptCard, 'text' | 'category' | 'difficulty' | 'active' | 'seasonalTag'>>) { const value = await this.repository.update(id, patch); await this.load(); return value; }
  async record(text: string, solved: number, totalSolveMs: number) { await this.repository.record(text, solved, totalSolveMs); const card = this.cards.find((value) => key(value.text) === key(text)); if (card) { card.timesPlayed += 1; card.timesSolved += solved; card.averageSolveMs = card.timesSolved ? Math.round(((card.averageSolveMs * (card.timesSolved - solved)) + totalSolveMs) / card.timesSolved) : 0; } }
}

function defaultPromptCards(): PromptCard[] { const now = Date.now(); const cards = Object.entries(WORDS).flatMap(([category, words]) => { const ranked = [...words].sort((a, b) => complexity(a) - complexity(b)); return words.map((text) => { const portion = ranked.indexOf(text) / ranked.length; const difficulty: PromptDifficulty = portion < .34 ? 'easy' : portion < .67 ? 'medium' : 'hard'; return { id: stableId(text), text, category, difficulty, active: true, timesPlayed: 0, timesSolved: 0, averageSolveMs: 0, createdAt: now, updatedAt: now }; }); }); return cards.filter((card, index) => cards.findIndex((value) => key(value.text) === key(card.text)) === index); }
function stableId(text: string) { const hex = createHash('sha256').update(`sketch-arena:${key(text)}`).digest('hex').slice(0, 32); return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`; }
function key(text: string) { return text.trim().toLocaleLowerCase().replace(/\s+/g, ' '); }
function complexity(text: string) { const words = text.trim().split(/\s+/); return text.length + words.length * 8 + (/(doing|using|taking|making|with|without| at | in | on | under | over )/i.test(` ${text} `) ? 14 : 0); }
function utcDay(now: number) { return new Date(now).toISOString().slice(0, 10); }
function dailyCards(cards: PromptCard[], now: number) { const day = utcDay(now); return [...cards].sort((a, b) => createHash('sha256').update(`${day}:${a.id}`).digest('hex').localeCompare(createHash('sha256').update(`${day}:${b.id}`).digest('hex'))).slice(0, 60); }
function row(value: Record<string, unknown>): PromptCard { const solved = Number(value.times_solved); return { id: String(value.id), text: String(value.text), category: String(value.category), difficulty: value.difficulty as PromptDifficulty, active: Boolean(value.active), seasonalTag: value.seasonal_tag ? String(value.seasonal_tag) : undefined, timesPlayed: Number(value.times_played), timesSolved: solved, averageSolveMs: solved ? Math.round(Number(value.total_solve_ms) / solved) : 0, createdAt: new Date(String(value.created_at)).getTime(), updatedAt: new Date(String(value.updated_at)).getTime() }; }
