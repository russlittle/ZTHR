import { sentence } from './dates.js';

/**
 * Meal plans that fit a food budget (PRD HH-2). A week of simple, filling meals built from shelf-stable and frozen
 * staples that most stores carry and SNAP covers, scaled to the household, with one shopping list. No prices are
 * quoted: they change by store and week. The budget shown is the student's own number (their SNAP estimate or what
 * they said they spend), divided across the weeks of the month.
 */
export interface Meal {
  day: string;
  breakfast: string;
  lunch: string;
  dinner: string;
}

export interface MealPlan {
  people: number;
  weeklyBudget?: number;
  meals: Meal[];
  shopping: { item: string; amount: string }[];
  tips: string[];
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const BREAKFAST = ['Oatmeal with banana', 'Eggs and toast', 'Oatmeal with peanut butter', 'Eggs and toast', 'Oatmeal with banana', 'Pancakes from a mix', 'Eggs and potatoes'];
const LUNCH = ['Peanut butter sandwich and an apple', 'Leftover rice and beans', 'Tuna sandwich and carrots', 'Leftover pasta', 'Bean and cheese quesadilla', 'Leftover soup', 'Egg fried rice'];
const DINNER = ['Rice and beans with frozen vegetables', 'Pasta with tomato sauce and frozen broccoli', 'Chicken thighs, potatoes and green beans', 'Lentil soup with bread', 'Chili with beans over rice', 'Baked potatoes with cheese and broccoli', 'Chicken and vegetable stir fry over rice'];
const VEG = ['tofu', 'beans'];

/** How much of each staple a week of these meals takes for one person; scaled by people. */
const PER_PERSON: [string, number, string][] = [
  ['Rice', 1.5, 'pounds'],
  ['Dry or canned beans', 3, 'cans or cups'],
  ['Pasta', 0.75, 'pounds'],
  ['Canned tomato sauce', 1, 'jars'],
  ['Oats', 1, 'canisters'],
  ['Eggs', 1, 'dozen'],
  ['Bread', 1, 'loaves'],
  ['Peanut butter', 0.5, 'jars'],
  ['Bananas or apples', 6, 'pieces'],
  ['Frozen vegetables', 3, 'bags'],
  ['Potatoes', 3, 'pounds'],
  ['Chicken thighs', 1.5, 'pounds'],
  ['Lentils', 0.5, 'pounds'],
  ['Shredded cheese', 0.5, 'bags'],
  ['Tortillas', 0.5, 'packs'],
  ['Canned tuna', 2, 'cans'],
  ['Carrots', 1, 'bags'],
];

const round = (n: number) => (n >= 3 ? Math.ceil(n) : Math.ceil(n * 2) / 2);

export function mealPlan(people: number, opts: { monthlyFoodMoney?: number; vegetarian?: boolean } = {}): MealPlan {
  const n = Math.max(1, Math.min(10, Math.round(people)));
  const swap = (t: string) => (opts.vegetarian ? t.replace(/chicken thighs/gi, VEG[0]!).replace(/chicken/gi, VEG[1]!).replace(/tuna/gi, 'egg salad') : t);
  const meals = DAYS.map((day, i) => ({ day, breakfast: BREAKFAST[i]!, lunch: swap(LUNCH[i]!), dinner: swap(DINNER[i]!) }));
  const shopping = PER_PERSON.filter(([item]) => !(opts.vegetarian && /chicken|tuna/i.test(item))).map(([item, per, unit]) => ({ item, amount: `${round(per * n)} ${unit}` }));
  if (opts.vegetarian) shopping.push({ item: 'Tofu', amount: `${round(1 * n)} blocks` });
  return {
    people: n,
    weeklyBudget: opts.monthlyFoodMoney ? Math.floor(opts.monthlyFoodMoney / 4.3) : undefined,
    meals,
    shopping,
    tips: [
      'Cook rice and beans once for two or three meals.',
      'Frozen vegetables are as healthy as fresh and do not go bad.',
      'Store brands are usually the same food for less.',
      'SNAP can be used online at many stores for pickup or delivery.',
    ],
  };
}

export function mealPlanText(p: MealPlan, brief = false): string {
  const head = sentence(`Here is a week of simple meals for ${p.people === 1 ? 'one person' : `${p.people} people`}${p.weeklyBudget ? `, for about $${p.weeklyBudget} a week` : ''}`);
  if (brief) return `${head} Dinners: ${p.meals.slice(0, 3).map((m) => m.dinner.toLowerCase()).join('; ')}, and more. I made one shopping list.`;
  return `${head}\n${p.meals.map((m) => `${m.day}: ${m.dinner}`).join('\n')}\nBreakfasts are oatmeal or eggs; lunches use leftovers. I made one shopping list for all of it.`;
}
