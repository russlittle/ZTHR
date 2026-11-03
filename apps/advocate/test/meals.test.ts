// Verifies docs/flows/meals.md
import { describe, expect, it } from 'vitest';
import { mealPlan, mealPlanText } from '../src/domain/meals.js';
import { checkTone } from '../src/domain/tone.js';
import { Advocate } from '../src/agents/advocate.js';
import { PERSONAS, PERSONA_NAMES } from '../src/server/demo.js';

describe('meal plans', () => {
  for (const people of [1, 2, 3, 4, 5, 6, 8, 10]) {
    it(`${people} people: seven days, three meals, a list that grows with the household`, () => {
      const p = mealPlan(people);
      expect(p.meals).toHaveLength(7);
      for (const m of p.meals) expect(m.breakfast && m.lunch && m.dinner).toBeTruthy();
      const eggs = Number(p.shopping.find((x) => x.item === 'Eggs')!.amount.split(' ')[0]);
      expect(eggs).toBeGreaterThanOrEqual(people >= 3 ? people : 1);
    });
  }
  it("never quotes a price; the only money is the student's own budget", () => {
    const p = mealPlan(3, { monthlyFoodMoney: 600 });
    expect(p.weeklyBudget).toBe(139);
    expect(JSON.stringify(p.shopping)).not.toMatch(/\$/);
  });
  it('a vegetarian plan has no meat or fish anywhere', () => {
    expect(JSON.stringify(mealPlan(2, { vegetarian: true }))).not.toMatch(/chicken|tuna|beef|pork/i);
  });
  it('clamps a strange household size instead of breaking', () => {
    expect(mealPlan(0).people).toBe(1);
    expect(mealPlan(99).people).toBe(10);
  });
  for (const brief of [false, true]) {
    it(`the message reads plainly (${brief ? 'brief' : 'walk me through'})`, () =>
      expect(checkTone({ text: mealPlanText(mealPlan(3, { monthlyFoodMoney: 500 }), brief), nextSteps: [{ label: 'x', action: 'x' }], urgency: 'routine' }, brief ? 'brief' : 'walk-me-through', 8, 'en').problems).toEqual([]));
  }
});

describe('in the Advocate', () => {
  for (const name of PERSONA_NAMES) {
    it(`${name}: asking for a meal plan by text gets one, sized to the household`, () => {
      const a = new Advocate({ today: () => '2026-11-02' });
      const s = PERSONAS[name]!(a);
      const [m] = a.converse(s.id, 'can you make me a meal plan');
      expect(m!.text).toContain(s.household.size === 1 ? 'one person' : `${s.household.size} people`);
      expect(m!.status).toBe('delivered');
    });
  }
  it("Maria's plan uses her SNAP estimate", () => {
    const a = new Advocate({ today: () => '2026-11-02' });
    expect(a.mealPlan(PERSONAS.Maria!(a).id).weeklyBudget).toBeGreaterThan(0);
  });
});
