import type { Language } from './types.js';

/**
 * Spanish for the core flows (PRD LNG-1, first slice): starting by text, crisis
 * replies, help found and money found. Resource names stay as their agencies
 * publish them. Other flows still answer in English and are tracked as not yet
 * translated.
 */
export function detectSpanish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-záéíóúñü]+/g) ?? [];
  const es = ['hola', 'ayuda', 'necesito', 'comida', 'renta', 'luz', 'pagar', 'quiero', 'tengo', 'por', 'favor', 'gracias', 'mi', 'no', 'puedo', 'alquiler', 'trabajo', 'escuela', 'dinero', 'cuenta', 'casa'];
  const hits = words.filter((w) => es.includes(w)).length;
  return hits >= 2 || /[ñ¿¡]/.test(text);
}

const T = {
  startNeed: {
    en: "Hi, I'm your Advocate. I work for you, not your college. Here's something you can do right now: call 2-1-1 any time to reach local help with bills, food and housing.",
    es: 'Hola, soy tu Advocate. Trabajo para ti, no para tu colegio. Algo que puedes hacer ahora mismo: llama al 2-1-1 a cualquier hora para encontrar ayuda local con cuentas, comida y vivienda.',
  },
  askWhere: {
    en: 'To find help near you, which college do you go to, and what is your ZIP code? (Example: Sinclair 45402) By replying, you confirm you are 18 or older.',
    es: '¿A qué colegio vas y cuál es tu código postal? (Ejemplo: Sinclair 45402) Al responder, confirmas que tienes 18 años o más.',
  },
  askHousehold: {
    en: 'Want me to check for money you could get too? How many people live with you, counting you, and about how much does your household earn a month? (Example: 3 people, $1800)',
    es: '¿Quieres que también revise si puedes recibir dinero? ¿Cuántas personas viven contigo, contándote a ti, y cuánto ganan al mes más o menos? (Ejemplo: 3 personas, $1800)',
  },
  helpHeader: { en: "Here's {need} help that fits you:", es: 'Esta es ayuda de {need} para ti:' },
  helpAsk: { en: 'Want me to start one?', es: '¿Quieres que empiece con una?' },
  start: { en: 'Start', es: 'Empezar' },
  call211: { en: 'Call 2-1-1', es: 'Llamar al 2-1-1' },
} as const;

const NEED_ES: Record<string, string> = {
  food: 'comida', housing: 'vivienda', utilities: 'servicios (luz, gas, agua)', money: 'dinero', transportation: 'transporte', childcare: 'cuidado de niños',
  'phone-internet': 'teléfono o internet', legal: 'ayuda legal', books: 'libros', 'mental-health': 'apoyo emocional', caregiving: 'cuidado de familiares', career: 'empleo',
};

export function t(key: keyof typeof T, lang: Language, vars: Record<string, string> = {}): string {
  let s: string = T[key][lang];
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, lang === 'es' ? (NEED_ES[v] ?? v) : v.replace('-', ' '));
  return s;
}

export function crisisReplyEs(withDanger: boolean, abuse: boolean): string {
  const lines = [
    'Gracias por decírmelo. Mereces apoyo ahora mismo.',
    'Puedes llamar al 988 a cualquier hora y oprimir el 2 para hablar en español. Es gratis y confidencial.',
  ];
  if (withDanger) lines.push('Si estás en peligro inmediato, llama al 911.');
  if (abuse) lines.push('La Línea Nacional sobre la Violencia Doméstica es 1-800-799-7233.');
  lines.push('Aquí estoy también. ¿Te acompaño mientras buscas ayuda?');
  return lines.join(' ');
}
