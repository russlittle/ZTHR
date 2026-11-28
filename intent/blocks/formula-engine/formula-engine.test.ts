import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calc, colName, colNumber, compare, dateOf, display, formatText, FormulaError, FormulaSyntaxError, FUNCTIONS, fromTyped, isError, parse, parseRef, serialOf, Workbook, type Scalar } from './index.ts';

const clock = { now: () => new Date('2026-03-09T15:30:00Z'), random: () => 0.25 };
const c = (f: string, cells: Record<string, Scalar> = {}) => {
  const v = calc(f, cells, { clock });
  return isError(v) ? v.code : v;
};

test('operators follow Excel precedence and associativity', () => {
  assert.equal(c('=-2^2'), 4, 'unary minus binds tighter than ^');
  assert.equal(c('=2^3^2'), 64, '^ is left to right');
  assert.equal(c('=2+3*4'), 14);
  assert.equal(c('=(2+3)*4'), 20);
  assert.equal(c('=7-2-1'), 4);
  assert.equal(c('=10/4'), 2.5);
  assert.equal(c('=50%'), 0.5);
  assert.equal(c('=200*10%'), 20);
  assert.equal(c('=2^-1'), 0.5);
  assert.equal(c('="a"&"b"&1'), 'ab1');
  assert.equal(c('=1+2&"x"'), '3x', '+ before &');
  assert.equal(c('=1+1=2'), true, 'comparison last');
  assert.equal(c('= 1 + 2 '), 3, 'spaces are ignored');
  assert.equal(c('=1.5e2+.5'), 150.5);
  assert.equal(c('="say ""hi"""'), 'say "hi"');
});

test('errors are values that travel, and IFERROR catches them', () => {
  assert.equal(c('=1/0'), '#DIV/0!');
  assert.equal(c('="a"+1'), '#VALUE!');
  assert.equal(c('=NOSUCH(1)'), '#NAME?');
  assert.equal(c('=foo+1'), '#NAME?');
  assert.equal(c('=SQRT(-1)'), '#NUM!');
  assert.equal(c('=1+#N/A'), '#N/A');
  assert.equal(c('=LN(0)'), '#NUM!');
  assert.equal(c('=0^-1'), '#DIV/0!');
  assert.equal(c('=IFERROR(1/0,"fallback")'), 'fallback');
  assert.equal(c('=IFERROR(5,"fallback")'), 5);
  assert.equal(c('=IFNA(NA(),"none")'), 'none');
  assert.equal(c('=IFNA(1/0,"none")'), '#DIV/0!', 'IFNA only catches #N/A');
  assert.equal(c('=ISERROR(1/0)'), true);
  assert.equal(c('=ISNA(NA())'), true);
  assert.equal(c('=IF(TRUE,1,1/0)'), 1, 'the branch not taken is never evaluated');
  assert.equal(c('=IF()'), '#VALUE!', 'wrong argument count');
  assert.equal(c('=ROUND(1)'), '#VALUE!');
});

test('text and numbers convert the usual ways, and compare in Excel order', () => {
  assert.equal(c('="3"+4'), 7);
  assert.equal(c('=TRUE+1'), 2);
  assert.equal(c('=VALUE("1e3")'), 1000);
  assert.equal(c('=VALUE("")'), '#VALUE!');
  assert.equal(c('=VALUE("12%")'), 0.12);
  assert.equal(c('=1&""'), '1');
  assert.equal(c('=0.1+0.2&""'), '0.3', 'shown to 15 significant digits');
  assert.equal(c('=1<"a"'), true, 'numbers sort before text');
  assert.equal(c('="a"<TRUE'), true, 'text before booleans');
  assert.equal(c('="ABC"="abc"'), true);
  assert.equal(c('=A1=0'), true, 'a blank equals zero');
  assert.equal(c('=A1=""'), true, 'and equals empty text');
  assert.equal(c('=A1<>"x"'), true);
  assert.equal(compare(null, null), 0);
  assert.equal(compare('b', 'A'), 1);
});

test('aggregates read ranges the way spreadsheets do', () => {
  const cells = { A1: 1, A2: 'x', A3: 2, A4: null, A5: true };
  assert.equal(c('=SUM(A1:A5)', cells), 3, 'text and booleans in a range are not counted');
  assert.equal(c('=SUM(A1:A3,10)', cells), 13);
  assert.equal(c('=SUM("3",TRUE)'), 4, 'typed-in arguments are coerced');
  assert.equal(c('=SUM("x")'), '#VALUE!');
  assert.equal(c('=AVERAGE(A1:A5)', cells), 1.5);
  assert.equal(c('=AVERAGE(A2:A2)', cells), '#DIV/0!');
  assert.deepEqual([c('=COUNT(A1:A5)', cells), c('=COUNTA(A1:A5)', cells), c('=COUNTBLANK(A1:A5)', cells)], [2, 4, 1]);
  assert.deepEqual([c('=MIN(A1:A5)', cells), c('=MAX(A1:A5)', cells), c('=MAX(A2:A2)', cells)], [1, 2, 0]);
  assert.equal(c('=SUM(A1:A2)', { A1: 1, A2: new FormulaError('#REF!') }), '#REF!');
  assert.equal(c('=PRODUCT(2,3,4)'), 24);
  assert.equal(c('=SUMPRODUCT(A1:A2,B1:B2)', { A1: 1, A2: 2, B1: 3, B2: 4 }), 11);
  assert.equal(c('=SUMPRODUCT(A1:A2,B1:B3)', { A1: 1 }), '#VALUE!');
  assert.equal(c('=A1:A3+1', { A1: 1 }), 2, 'a range outside a function takes its first cell');
});

test('rounding goes half away from zero, exactly as spreadsheets show it', () => {
  assert.deepEqual([c('=ROUND(2.5,0)'), c('=ROUND(-2.5,0)'), c('=ROUND(1.005,2)'), c('=ROUND(2.675,2)'), c('=ROUND(1234.5678,-2)')], [3, -3, 1.01, 2.68, 1200]);
  assert.deepEqual([c('=ROUNDUP(3.2,0)'), c('=ROUNDUP(-3.2,0)'), c('=ROUNDDOWN(-3.9,0)'), c('=ROUNDDOWN(3.999,2)')], [4, -4, -3, 3.99]);
  assert.deepEqual([c('=INT(-1.5)'), c('=TRUNC(-1.5)'), c('=TRUNC(8.987,1)'), c('=MOD(-3,2)'), c('=MOD(3,-2)'), c('=MOD(5,0)')], [-2, -1, 8.9, 1, -1, '#DIV/0!']);
  assert.deepEqual([c('=CEILING(2.1,0.5)'), c('=FLOOR(2.7,0.5)'), c('=POWER(2,10)'), c('=SIGN(-4)'), c('=ABS(-4.5)'), c('=EXP(0)'), c('=LOG(8,2)'), c('=LOG10(1000)')], [2.5, 2.5, 1024, -1, 4.5, 1, 3, 3]);
  assert.deepEqual([c('=FACT(5)'), c('=FACT(171)'), c('=GCD(12,18)'), c('=LCM(4,6)'), c('=ISEVEN(4)'), c('=ISODD(4)')], [120, '#NUM!', 6, 12, true, false]);
  assert.equal(Number(c('=PI()')).toFixed(5), '3.14159');
});

test('statistics: median, spread, order statistics', () => {
  const data = { A1: 2, A2: 4, A3: 4, A4: 4, A5: 5, A6: 5, A7: 7, A8: 9 };
  assert.equal(c('=MEDIAN(A1:A8)', data), 4.5);
  assert.equal(c('=MEDIAN(1,3,2)'), 2);
  assert.equal(c('=STDEV.P(A1:A8)', data), 2);
  assert.equal(Number(c('=STDEV.S(A1:A8)', data)).toFixed(4), '2.1381');
  assert.equal(c('=VAR.P(A1:A8)', data), 4);
  assert.equal(c('=STDEV(5)'), '#DIV/0!');
  assert.deepEqual([c('=LARGE(A1:A8,1)', data), c('=LARGE(A1:A8,3)', data), c('=SMALL(A1:A8,2)', data), c('=LARGE(A1:A8,9)', data)], [9, 5, 4, '#NUM!']);
});

test('text functions', () => {
  assert.deepEqual([c('=LEN("héllo")'), c('=LEFT("hello",2)'), c('=LEFT("hello")'), c('=RIGHT("hello",3)'), c('=MID("hello",2,3)'), c('=MID("hello",9,3)')], [5, 'he', 'h', 'llo', 'ell', '']);
  assert.deepEqual([c('=UPPER("aB")'), c('=LOWER("aB")'), c('=PROPER("hello wORLD o\'neil")'), c('=TRIM("  a   b ")')], ['AB', 'ab', "Hello World O'Neil", 'a b']);
  assert.deepEqual([c('=SUBSTITUTE("a-b-c","-","+")'), c('=SUBSTITUTE("a-b-c","-","+",2)'), c('=REPLACE("abcdef",2,3,"X")'), c('=REPT("ab",3)'), c('=EXACT("a","A")')], ['a+b+c', 'a-b+c', 'aXef', 'ababab', false]);
  assert.deepEqual([c('=FIND("b","abc")'), c('=FIND("B","abc")'), c('=SEARCH("B","abc")'), c('=SEARCH("a?c","xabc")'), c('=FIND("b","abcb",3)')], [2, '#VALUE!', 2, 2, 4]);
  assert.deepEqual([c('=TEXTJOIN(", ",TRUE,"a","","b")'), c('=TEXTJOIN("-",FALSE,"a","","b")'), c('=CONCAT("a",1,TRUE)'), c('=CONCATENATE("x","y")'), c('=CHAR(65)'), c('=CODE("A")')], ['a, b', 'a--b', 'a1TRUE', 'xy', 'A', 65]);
  assert.equal(c('=CONCAT(A1:A3)', { A1: 'x', A2: 1, A3: null }), 'x1');
  assert.equal(c('=LEFT("a",-1)'), '#VALUE!');
});

test('TEXT formats numbers, percentages and dates', () => {
  assert.deepEqual([formatText(1234.5, '#,##0.00'), formatText(0.256, '0.0%'), formatText(5, '000'), formatText(-1234.567, '#,##0.0'), formatText(0.5, '0.00'), formatText(1234567, '#,##0'), formatText(0, '0.00'), formatText(-0.001, '0.00')], ['1,234.50', '25.6%', '005', '-1,234.6', '0.50', '1,234,567', '0.00', '0.00']);
  assert.equal(c('=TEXT(DATE(2026,3,9),"yyyy-mm-dd")'), '2026-03-09');
  assert.equal(c('=TEXT(DATE(2026,3,9),"dddd, mmmm d, yyyy")'), 'Monday, March 9, 2026');
  assert.equal(c('=TEXT(DATE(2026,3,9),"ddd dd/mm/yy")'), 'Mon 09/03/26');
  assert.equal(c('=TEXT(0.75,"h:mm")'), '18:00');
  assert.equal(c('=TEXT(0.5+1/1440*5,"hh:mm:ss")'), '12:05:00');
  assert.equal(c('="Total: "&TEXT(12.5,"$#,##0.00")'), 'Total: $12.50');
});

test('logic functions short-circuit and refuse non-logical text', () => {
  assert.deepEqual([c('=IF(1>2,"a","b")'), c('=IF(0,1)'), c('=IF("x",1,2)'), c('=IF(A1,1,2)', { A1: 'TRUE' })], ['b', false, '#VALUE!', 1]);
  assert.deepEqual([c('=IFS(A1>10,"big",A1>5,"mid",TRUE,"small")', { A1: 7 }), c('=IFS(FALSE,1)'), c('=SWITCH(2,1,"one",2,"two","other")'), c('=SWITCH(9,1,"one","other")'), c('=SWITCH(9,1,"one")')], ['mid', '#N/A', 'two', 'other', '#N/A']);
  assert.deepEqual([c('=AND(TRUE,1,"TRUE")'), c('=AND(TRUE,FALSE)'), c('=OR(FALSE,0)'), c('=XOR(TRUE,TRUE,TRUE)'), c('=NOT(0)'), c('=AND(A1:A2)', { A1: true, A2: 'text' })], [true, false, false, true, true, true]);
  assert.deepEqual([c('=ISBLANK(A1)'), c('=ISNUMBER(1)'), c('=ISTEXT("a")'), c('=ISLOGICAL(TRUE)'), c('=ISNUMBER("1")')], [true, true, true, true, false]);
  assert.equal(c('=CHOOSE(2,"a","b","c")'), 'b');
  assert.equal(c('=CHOOSE(4,"a","b","c")'), '#VALUE!');
});

test('lookups find exact and nearest matches, and say #N/A when there is none', () => {
  const t = { A1: 'apple', B1: 10, A2: 'banana', B2: 20, A3: 'cherry', B3: 30, D1: 1, D2: 10, D3: 100 };
  assert.deepEqual([c('=VLOOKUP("banana",A1:B3,2,FALSE)', t), c('=VLOOKUP("BANANA",A1:B3,2,0)', t), c('=VLOOKUP("pear",A1:B3,2,FALSE)', t), c('=VLOOKUP("a*",A1:B3,2,FALSE)', t), c('=VLOOKUP("x",A1:B3,3,FALSE)', t)], [20, 20, '#N/A', 10, '#REF!']);
  assert.deepEqual([c('=VLOOKUP(50,D1:D3,1)', t), c('=VLOOKUP(0,D1:D3,1)', t), c('=VLOOKUP(1000,D1:D3,1)', t)], [10, '#N/A', 100]);
  assert.equal(c('=HLOOKUP("b",A1:C2,2,FALSE)', { A1: 'a', B1: 'b', C1: 'c', A2: 1, B2: 2, C2: 3 }), 2);
  assert.deepEqual([c('=INDEX(A1:B3,2,2)', t), c('=INDEX(A1:B3,3,1)', t), c('=INDEX(D1:D3,2)', t), c('=INDEX(A1:B3,4,1)', t)], [20, 'cherry', 10, '#REF!']);
  assert.deepEqual([c('=MATCH("cherry",A1:A3,0)', t), c('=MATCH(50,D1:D3,1)', t), c('=MATCH(5,D1:D3,0)', t), c('=MATCH(50,D3:D1,-1)', { D1: 100, D2: 10, D3: 1 })], [3, 2, '#N/A', 1]);
  assert.deepEqual([c('=ROWS(A1:B3)'), c('=COLUMNS(A1:B3)')], [3, 2]);
});

test('conditional aggregates use criteria with operators and wildcards', () => {
  const d = { A1: 'apple', A2: 'avocado', A3: 'banana', A4: 'Apple', B1: 1, B2: 5, B3: 10, B4: 20, C1: 'x', C2: 'y', C3: 'x', C4: 'x' };
  assert.deepEqual([c('=COUNTIF(A1:A4,"a*")', d), c('=COUNTIF(A1:A4,"apple")', d), c('=COUNTIF(A1:A4,"<>apple")', d), c('=COUNTIF(B1:B4,">4")', d), c('=COUNTIF(B1:B4,5)', d), c('=COUNTIF(A1:A4,"?anana")', d)], [3, 2, 2, 3, 1, 1]);
  assert.deepEqual([c('=SUMIF(B1:B4,">4")', d), c('=SUMIF(A1:A4,"a*",B1:B4)', d), c('=SUMIFS(B1:B4,C1:C4,"x",B1:B4,">1")', d), c('=COUNTIFS(C1:C4,"x",B1:B4,"<=10")', d), c('=AVERAGEIF(C1:C4,"x",B1:B4)', d), c('=AVERAGEIF(C1:C4,"z",B1:B4)', d)], [35, 26, 30, 2, 31 / 3, '#DIV/0!']);
  assert.equal(c('=SUMIFS(B1:B4,C1:C3,"x")', d), '#VALUE!', 'ranges must be the same size');
});

test('dates are Excel serials, with the 1900 quirk', () => {
  assert.equal(serialOf(2000, 1, 1), 36526);
  assert.equal(serialOf(1900, 3, 1), 61);
  assert.equal(serialOf(1900, 1, 1), 1);
  assert.deepEqual(dateOf(60), { y: 1900, m: 2, d: 29 });
  assert.deepEqual(dateOf(61), { y: 1900, m: 3, d: 1 });
  assert.deepEqual(dateOf(46_090), { y: 2026, m: 3, d: 9 });
  assert.equal(dateOf(-1), undefined);
  assert.deepEqual([c('=DATE(2026,3,9)'), c('=DATE(2026,14,1)'), c('=DATE(2026,2,30)'), c('=DATE(2026,0,1)'), c('=DATE(26,1,1)')], [46_090, serialOf(2027, 2, 1), serialOf(2026, 3, 2), serialOf(2025, 12, 1), serialOf(1926, 1, 1)]);
  assert.deepEqual([c('=YEAR(46090)'), c('=MONTH(46090)'), c('=DAY(46090)'), c('=WEEKDAY(46090)'), c('=WEEKDAY(46090,2)'), c('=WEEKDAY(46090,3)'), c('=DAYS(46100,46090)')], [2026, 3, 9, 2, 1, 0, 10]);
  assert.deepEqual([c('=EDATE(DATE(2026,1,31),1)'), c('=EDATE(DATE(2026,3,31),-1)'), c('=EOMONTH(DATE(2026,1,15),1)'), c('=EOMONTH(DATE(2024,1,15),1)'), c('=EOMONTH(DATE(2026,1,15),0)')], [serialOf(2026, 2, 28), serialOf(2026, 2, 28), serialOf(2026, 2, 28), serialOf(2024, 2, 29), serialOf(2026, 1, 31)]);
  assert.equal(c('=TODAY()'), 46_090, 'the injected clock');
  assert.equal(c('=NOW()'), 46_090 + 15.5 / 24);
  assert.equal(c('=RAND()'), 0.25);
  assert.equal(c('=RANDBETWEEN(1,10)'), 3);
});

test('references: absolute marks, columns, and bad cells', () => {
  assert.deepEqual(parseRef('$B$12'), { col: 2, row: 12, absCol: true, absRow: true });
  assert.deepEqual(parseRef('aa1'), { col: 27, row: 1, absCol: false, absRow: false });
  assert.equal(parseRef('XFD1048576')!.col, 16384);
  assert.equal(parseRef('XFE1'), undefined);
  assert.equal(parseRef('A0'), undefined);
  assert.equal(parseRef('A1048577'), undefined);
  assert.deepEqual([colName(1), colName(26), colName(27), colName(702), colName(703), colNumber('AZ')], ['A', 'Z', 'AA', 'ZZ', 'AAA', 52]);
  assert.equal(c('=$A$1+B$2', { A1: 1, B2: 2 }), 3);
});

test('a workbook evaluates formulas across cells and sheets, and recalculates only what changed', () => {
  const wb = new Workbook({ clock });
  wb.set('Sheet1', 'A1', 10);
  wb.set('Sheet1', 'A2', 20);
  wb.set('Sheet1', 'A3', '=A1+A2');
  wb.set('Sheet1', 'B1', '=SUM(A1:A3)*2');
  wb.set('My Data', 'A1', '=Sheet1!A3+1');
  wb.set('Sheet1', 'C1', "='My Data'!A1&\"!\"");
  assert.deepEqual([wb.get('Sheet1', 'A3'), wb.get('Sheet1', 'B1'), wb.get('My Data', 'A1'), wb.get('Sheet1', 'C1')], [30, 120, 31, '31!']);
  wb.set('Sheet1', 'A1', 100);
  assert.deepEqual([wb.get('Sheet1', 'A3'), wb.get('Sheet1', 'B1'), wb.get('My Data', 'A1'), wb.get('Sheet1', 'C1')], [120, 480, 121, '121!']);
  assert.equal(wb.get('Sheet1', 'Z9'), null);
  assert.equal(isError(wb.get('Nowhere', 'A1')), true);
  assert.equal(display(wb.get('Sheet1', 'B1')), '480');
  assert.equal(wb.input('Sheet1', 'A3'), '=A1+A2');
  wb.set('Sheet1', 'A1', null);
  assert.equal(wb.get('Sheet1', 'A3'), 20);
  assert.equal(c('=Sheet2!A1'), '#REF!', 'a sheet that does not exist');
});

test('a range formula sees cells filled in later, even ones that were empty', () => {
  const wb = new Workbook();
  wb.set('S', 'B1', '=SUM(A1:A3)');
  assert.equal(wb.get('S', 'B1'), 0);
  wb.set('S', 'A2', 5);
  assert.equal(wb.get('S', 'B1'), 5);
  wb.set('S', 'C1', '=B1*2');
  wb.set('S', 'A3', 7);
  assert.equal(wb.get('S', 'C1'), 24);
  wb.set('S', 'D1', '=E1');
  assert.equal(wb.get('S', 'D1'), 0);
  wb.set('S', 'E1', 9);
  assert.equal(wb.get('S', 'D1'), 9, 'a point reference to an empty cell is tracked too');
});

test('the dependency graph answers what a cell reads and what reads it', () => {
  const wb = new Workbook();
  wb.set('S', 'A1', 1);
  wb.set('S', 'A2', 2);
  wb.set('S', 'B1', '=A1+A2');
  wb.set('S', 'B2', '=SUM(A1:A2)');
  wb.set('S', 'C1', '=B1+B2');
  wb.set('T', 'A1', '=S!C1');
  assert.deepEqual(wb.dependencies('S', 'C1'), ['B1', 'B2']);
  assert.deepEqual(wb.dependencies('S', 'B2'), ['A1', 'A2']);
  assert.deepEqual(wb.dependents('S', 'A1'), ['B1', 'B2', 'C1', 'T!A1']);
  assert.deepEqual(wb.dependents('S', 'C1'), ['T!A1']);
  assert.deepEqual(wb.dependents('S', 'Z1'), []);
});

test('reference cycles give #CIRC! to every cell in the loop and to what reads them, and clear when fixed', () => {
  const wb = new Workbook();
  wb.set('S', 'A1', '=B1');
  wb.set('S', 'B1', '=C1+1');
  wb.set('S', 'C1', '=A1');
  wb.set('S', 'D1', '=A1+1');
  wb.set('S', 'E1', 5);
  wb.set('S', 'F1', '=F1');
  wb.set('S', 'G1', '=E1*2');
  assert.deepEqual(['A1', 'B1', 'C1', 'D1', 'F1'].map((r) => display(wb.get('S', r))), ['#CIRC!', '#CIRC!', '#CIRC!', '#CIRC!', '#CIRC!']);
  assert.equal(wb.get('S', 'G1'), 10, 'cells outside the loop are unaffected');
  assert.deepEqual(wb.cycles(), ['S!A1', 'S!B1', 'S!C1', 'S!F1']);
  assert.equal(c('=IFERROR(1,2)'), 1);
  wb.set('S', 'C1', 1);
  assert.deepEqual([wb.get('S', 'B1'), wb.get('S', 'A1'), wb.get('S', 'D1')], [2, 2, 3]);
  assert.deepEqual(wb.cycles(), ['S!F1']);
});

test('a chain of twenty thousand cells evaluates without overflowing the stack', () => {
  const wb = new Workbook();
  wb.set('S', 'A1', 1);
  for (let r = 2; r <= 20_000; r++) wb.set('S', `A${r}`, `=A${r - 1}+1`);
  assert.equal(wb.get('S', 'A20000'), 20_000);
  wb.set('S', 'A1', 5);
  assert.equal(wb.get('S', 'A20000'), 20_004);
});

test('bad formulas are refused with a position, hostile ones are bounded', () => {
  const at = (f: string) => {
    try {
      parse(f);
      return 'parsed';
    } catch (e) {
      return e instanceof FormulaSyntaxError ? `${e.at}: ${e.message}` : `other: ${(e as Error).message}`;
    }
  };
  assert.equal(at('=1+'), '3: the formula ends too soon (at position 4)');
  assert.equal(at('=(1'), '3: expected ")" (at position 4)');
  assert.equal(at('=1 2'), '3: unexpected "2" (at position 4)');
  assert.equal(at('="abc'), '1: text is not closed (at position 2)');
  assert.equal(at('=1+@'), '3: unexpected "@" (at position 4)');
  assert.equal(at('=A1:5'), '4: a range needs a cell after ":" (at position 5)');
  assert.equal(at('=SUM(1,'), '7: the formula ends too soon (at position 8)');
  assert.match(at(`=${'('.repeat(500)}1${')'.repeat(500)}`), /nested too deeply/);
  assert.match(at(`=${'-'.repeat(500)}1`), /nested too deeply/);
  assert.match(at(`=1${'+1'.repeat(5000)}`), /too long/);
  const wb = new Workbook();
  wb.set('S', 'A1', '=1+');
  assert.equal(display(wb.get('S', 'A1')), '#NAME?');
  assert.match(wb.syntaxError('S', 'A1')!, /ends too soon/);
  assert.throws(() => wb.set('S', 'ZZZZ1', 1), RangeError);
});

test('there are more than 80 functions, and every one is reachable by name', () => {
  assert.ok(FUNCTIONS.length >= 80, `only ${FUNCTIONS.length}`);
  for (const f of ['SUM', 'IF', 'VLOOKUP', 'SUMIFS', 'TEXT', 'EOMONTH', 'IFERROR', 'MATCH', 'TEXTJOIN', 'COUNTIFS', 'STDEV.S', 'SWITCH', 'XOR']) assert.ok(FUNCTIONS.includes(f), f);
  assert.equal(c('=sum(1,2)'), 3, 'function names are not case sensitive');
});

test('typed input becomes values, and values display as a cell shows them', () => {
  assert.deepEqual(['12', ' 3.5 ', 'TRUE', 'false', '=A1', 'hello', '', '1,000'].map(fromTyped), [12, 3.5, true, false, '=A1', 'hello', null, '1,000']);
  assert.deepEqual([display(1 / 3), display(true), display(null), display(new FormulaError('#N/A')), display('x')], ['0.333333333333333', 'TRUE', '', '#N/A', 'x']);
});
