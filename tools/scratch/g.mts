import { readingGrade } from '../../apps/advocate/src/domain/tone.js';
import { fairChanceText, careerText } from '../../apps/advocate/src/domain/careers.js';
console.log(readingGrade(fairChanceText()).toFixed(1), readingGrade(careerText({ enrollment: { college: 'sinclair' } } as never)).toFixed(1));
