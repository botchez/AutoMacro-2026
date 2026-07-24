import type { FoodItem } from "./store";

// Per 100g reference values used to mock the "scanner" results
export const MOCK_FOOD_DB: Array<Omit<FoodItem, "id" | "grams"> & { per100: Macros }> = [
  {
    name: "Grilled chicken breast",
    calories: 165,
    protein: 31,
    carbs: 0,
    fat: 3.6,
    per100: { calories: 165, protein: 31, carbs: 0, fat: 3.6 },
  },
  {
    name: "Steamed broccoli",
    calories: 35,
    protein: 2.4,
    carbs: 7,
    fat: 0.4,
    per100: { calories: 35, protein: 2.4, carbs: 7, fat: 0.4 },
  },
  {
    name: "Brown rice",
    calories: 123,
    protein: 2.7,
    carbs: 26,
    fat: 1,
    per100: { calories: 123, protein: 2.7, carbs: 26, fat: 1 },
  },
  {
    name: "Avocado",
    calories: 160,
    protein: 2,
    carbs: 9,
    fat: 15,
    per100: { calories: 160, protein: 2, carbs: 9, fat: 15 },
  },
  {
    name: "Salmon fillet",
    calories: 208,
    protein: 20,
    carbs: 0,
    fat: 13,
    per100: { calories: 208, protein: 20, carbs: 0, fat: 13 },
  },
  {
    name: "Sweet potato",
    calories: 86,
    protein: 1.6,
    carbs: 20,
    fat: 0.1,
    per100: { calories: 86, protein: 1.6, carbs: 20, fat: 0.1 },
  },
  {
    name: "Greek yogurt",
    calories: 59,
    protein: 10,
    carbs: 3.6,
    fat: 0.4,
    per100: { calories: 59, protein: 10, carbs: 3.6, fat: 0.4 },
  },
  {
    name: "Banana",
    calories: 89,
    protein: 1.1,
    carbs: 23,
    fat: 0.3,
    per100: { calories: 89, protein: 1.1, carbs: 23, fat: 0.3 },
  },
  {
    name: "Almonds",
    calories: 579,
    protein: 21,
    carbs: 22,
    fat: 50,
    per100: { calories: 579, protein: 21, carbs: 22, fat: 50 },
  },
  {
    name: "Whole wheat bread",
    calories: 247,
    protein: 13,
    carbs: 41,
    fat: 3.4,
    per100: { calories: 247, protein: 13, carbs: 41, fat: 3.4 },
  },
];

type Macros = { calories: number; protein: number; carbs: number; fat: number };

export function scaleFood(perHundred: Macros, grams: number): Macros {
  const k = grams / 100;
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    calories: Math.round(perHundred.calories * k),
    protein: r(perHundred.protein * k),
    carbs: r(perHundred.carbs * k),
    fat: r(perHundred.fat * k),
  };
}

export const COACH_LINES = [
  "You're on a roll! Keep going 🌟",
  "Small bites, big wins.",
  "Protein first — future you says thanks!",
  "Hydration counts too — grab some water 💧",
  "One healthy choice at a time.",
  "Consistency beats perfection. Always.",
];

export function randomCoach() {
  return COACH_LINES[Math.floor(Math.random() * COACH_LINES.length)];
}
